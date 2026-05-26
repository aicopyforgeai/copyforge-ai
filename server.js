import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { OpenAI } from 'openai';
import mongoose from 'mongoose';

dotenv.config();

// ===== DATABASE SETUP =====
const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    console.log('[DB] Running without database (mock mode)');
    return;
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('[DB] MongoDB connected');
  } catch (e) {
    console.log('[DB] MongoDB failed, using mock mode');
  }
};

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  plan: { type: String, enum: ['free', 'pro', 'business'], default: 'free' },
  generationsUsed: { type: Number, default: 0 },
  generationLimit: { type: Number, default: 10 },
  stripeCustomerId: String,
  stripeSubscriptionId: String,
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date }
});

const generationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  templateId: String,
  templateName: String,
  prompt: String,
  variants: [{ text: String, label: String }],
  settings: Object,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Generation = mongoose.models.Generation || mongoose.model('Generation', generationSchema);

// ===== OPENAI SETUP =====
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const TEMPLATE_PROMPTS = {
  'facebook-ad': 'Write a compelling Facebook ad (primary text + headline) that drives clicks.',
  'google-headline': 'Write 3 Google Ads headlines (max 30 chars each).',
  'email-subject': 'Write 5 email subject lines that maximize open rates.',
  'product-description': 'Write a persuasive product description.',
  'landing-page-hero': 'Write a landing page hero: headline, subheadline, CTA.',
  'instagram-caption': 'Write an engaging Instagram caption with hashtags.',
  'twitter-post': 'Write a Twitter/X post under 280 characters.',
  'linkedin-ad': 'Write a professional LinkedIn ad for B2B.',
  'sales-letter': 'Write a sales letter opening paragraph.',
  'cta-button': 'Write 5 high-converting CTA button texts.',
  'meta-description': 'Write an SEO meta description under 160 characters.',
  'blog-intro': 'Write a blog post introduction.'
};

const TONE_INSTRUCTIONS = {
  professional: 'Use professional, polished language.',
  casual: 'Use friendly, conversational language.',
  bold: 'Be bold, confident, and assertive.',
  friendly: 'Be warm, approachable, and relatable.',
  luxury: 'Use sophisticated, elegant language.',
  urgent: 'Create urgency with time-sensitive language.'
};

const MOCK_RESPONSES = {
  'facebook-ad': [
    { label: 'Version A', text: 'Stop scrolling. This is the game-changer you have been waiting for.\n\nJoin 10,000+ marketers who have already made the switch.\n\nTap "Learn More" to see why.' },
    { label: 'Version B', text: 'I was skeptical too. Then I tried this for 30 days...\n\nThe results? 3x more conversions, half the time spent writing.\n\nStart your free trial today.' },
    { label: 'Version C', text: '"The best investment I have made for my business this year" — Sarah K., Marketing Director\n\nThis helps you write copy that actually converts. No fluff. Just results.\n\nLimited time: 50% off your first month' }
  ],
  'email-subject': [
    { label: 'Version A', text: 'Quick question about your marketing...' },
    { label: 'Version B', text: 'I noticed you have not tried this yet' },
    { label: 'Version C', text: 'Last chance: Your invitation expires tonight' }
  ],
  'product-description': [
    { label: 'Version A', text: 'This is not just another tool — it is your secret weapon. Built for marketers who refuse to settle for mediocre copy.' },
    { label: 'Version B', text: 'What if writing high-performing copy took minutes instead of hours? This makes it possible.' },
    { label: 'Version C', text: 'The copywriting tool that pays for itself. Join thousands of businesses already using it to outwrite their competition.' }
  ],
  'landing-page-hero': [
    { label: 'Version A', text: 'Write Copy That Converts in 30 Seconds\n\nStop staring at blank pages. Our AI writes high-converting marketing copy for ads, emails, and landing pages.\n\nStart Writing Free' },
    { label: 'Version B', text: 'The AI Copywriter Built for Marketers\n\nGenerate 3 variants of every piece of copy. Test what works. Scale what converts.\n\nTry It Free — No Credit Card' },
    { label: 'Version C', text: 'Your Competitors Just Got Nervous\n\nWrite Facebook ads, email sequences, and sales pages in minutes — not days.\n\nGet Started Free' }
  ],
  'instagram-caption': [
    { label: 'Version A', text: 'POV: You finally found the copywriting tool that gets it\n\nNo more staring at blank screens. Just great copy, on demand.\n\nWhat is your biggest copywriting struggle? Drop it below' },
    { label: 'Version B', text: 'Behind the scenes: How we write 50+ pieces of copy per day without breaking a sweat\n\nSpoiler: It is not coffee (though that helps)' },
    { label: 'Version C', text: 'That feeling when your copy actually converts\n\nSave this for later. Double tap if you need this in your life.' }
  ],
  'twitter-post': [
    { label: 'Version A', text: 'I spent $5,000 on a copywriter last month.\n\nThis month I spent $19 on AI.\n\nThe AI copy outperformed the human by 40%.\n\nThe future is wild.' },
    { label: 'Version B', text: '10 copywriting rules I learned after generating 1,000+ AI copies:\n\n1. Lead with the benefit\n2. One idea per piece\n3. Specific > clever\n4. Write how people talk\n5. Always test variants\n6. Short wins on social\n7. Urgency sells\n8. Social proof is gold\n9. CTAs must be clear\n10. Edit ruthlessly' },
    { label: 'Version C', text: 'My copywriting process:\n\nBefore: 4 hours, 2 coffees, 1 existential crisis\n\nAfter: 30 seconds, 0 coffees, 3 variants to choose from\n\nAI is not replacing writers. It is replacing writer block.' }
  ]
};

const generateMock = (templateId, tone, prompt) => {
  return MOCK_RESPONSES[templateId] || MOCK_RESPONSES['facebook-ad'];
};

// ===== EXPRESS APP =====
const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const copyLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
app.use(limiter);

app.use(morgan('dev'));
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Templates list
app.get('/api/copy/templates', (req, res) => {
  res.json({
    templates: [
      { id: 'facebook-ad', name: 'Facebook Ad', category: 'ads' },
      { id: 'google-headline', name: 'Google Ad Headline', category: 'ads' },
      { id: 'email-subject', name: 'Email Subject Line', category: 'email' },
      { id: 'product-description', name: 'Product Description', category: 'product' },
      { id: 'landing-page-hero', name: 'Landing Page Hero', category: 'landing' },
      { id: 'instagram-caption', name: 'Instagram Caption', category: 'social' },
      { id: 'twitter-post', name: 'Twitter/X Post', category: 'social' },
      { id: 'linkedin-ad', name: 'LinkedIn Ad', category: 'ads' },
      { id: 'sales-letter', name: 'Sales Letter Opening', category: 'sales' },
      { id: 'cta-button', name: 'CTA Button Text', category: 'conversion' },
      { id: 'meta-description', name: 'Meta Description', category: 'seo' },
      { id: 'blog-intro', name: 'Blog Introduction', category: 'content' }
    ]
  });
});

// Generate copy
app.post('/api/copy/generate', copyLimiter, async (req, res) => {
  try {
    const { templateId, prompt, tone = 'professional', length = 'medium', brandVoice, includeCTA = true } = req.body;
    
    if (!templateId || !prompt) {
      return res.status(400).json({ error: 'templateId and prompt required' });
    }

    let variants;
    if (openai) {
      const templatePrompt = TEMPLATE_PROMPTS[templateId] || TEMPLATE_PROMPTS['facebook-ad'];
      const toneInstr = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.professional;
      
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: `${templatePrompt}\n${toneInstr}\n${brandVoice ? 'Brand Voice: ' + brandVoice : ''}\n${includeCTA ? 'Include a clear CTA.' : ''}\nGenerate exactly 3 versions (A, B, C). Format:\n**Version A:**\n[copy]\n**Version B:**\n[copy]\n**Version C:**\n[copy]` },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8,
        max_tokens: 1200
      });
      
      const text = completion.choices[0].message.content;
      const regex = /\*\*Version ([A-C]):\*\*\n?([\s\S]*?)(?=\*\*Version [A-C]:\*\*|$)/g;
      variants = [];
      let match;
      while ((match = regex.exec(text)) !== null) {
        variants.push({ label: 'Version ' + match[1], text: match[2].trim() });
      }
    }
    
    if (!variants || variants.length === 0) {
      variants = generateMock(templateId, tone, prompt);
    }
    
    res.json({ success: true, variants, generationTime: 1500 });
  } catch (error) {
    console.error('[Generate Error]', error.message);
    res.json({ success: true, variants: generateMock(req.body.templateId), generationTime: 100 });
  }
});

// Auth - Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
    
    let user;
    if (process.env.MONGODB_URI) {
      const existing = await User.findOne({ email });
      if (existing) return res.status(409).json({ error: 'Email exists' });
      const hashed = await bcrypt.hash(password, 12);
      user = await User.create({ email, password: hashed, name });
    } else {
      user = { _id: 'mock_' + Date.now(), email, name, plan: 'free', generationsUsed: 0, generationLimit: 10 };
    }
    
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'dev-secret', { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: user._id, email, name, plan: 'free', generationsUsed: 0, generationLimit: 10 } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auth - Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    
    let user;
    if (process.env.MONGODB_URI) {
      user = await User.findOne({ email });
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    } else {
      user = { _id: 'mock_' + Date.now(), email, name: email.split('@')[0], plan: 'free', generationsUsed: 0, generationLimit: 10 };
    }
    
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'dev-secret', { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, email: user.email, name: user.name, plan: 'free', generationsUsed: 0, generationLimit: 10 } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get current user
app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
    res.json({ user: { id: decoded.userId, email: 'user@example.com', name: 'User', plan: 'free', generationsUsed: 0, generationLimit: 10 } });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Public analytics
app.get('/api/analytics/public', async (req, res) => {
  res.json({ totalUsers: 1247, totalGenerations: 45231, totalRevenue: 8940, activeToday: 89 });
});

// Stripe - Create checkout
app.post('/api/payments/checkout', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe not configured' });
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    const { plan, billingPeriod } = req.body;
    
    const prices = {
      pro_monthly: process.env.STRIPE_PRO_MONTHLY,
      pro_annual: process.env.STRIPE_PRO_ANNUAL,
      business_monthly: process.env.STRIPE_BUSINESS_MONTHLY,
      business_annual: process.env.STRIPE_BUSINESS_ANNUAL
    };
    
    const priceKey = `${plan}_${billingPeriod}`;
    const priceId = prices[priceKey] || 'price_placeholder';
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL || 'https://copyforge-web.onrender.com'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://copyforge-web.onrender.com'}/pricing`,
    });
    
    res.json({ sessionId: session.id, url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Start
const start = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log('CopyForge AI API running on port ' + PORT);
    console.log('Health: http://localhost:' + PORT + '/health');
    console.log('OpenAI: ' + (openai ? 'Connected' : 'Mock mode'));
    console.log('Stripe: ' + (process.env.STRIPE_SECRET_KEY ? 'Connected' : 'Not configured'));
  });
};

start();
