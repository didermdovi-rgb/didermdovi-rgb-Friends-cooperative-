'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');

const whatsapp = require('./whatsapp');
const receipt = require('./receipt');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// CORS: only allow the configured origin(s) to call this API.
// ---------------------------------------------------------------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
app.use(
  cors({
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-Admin-Key']
  })
);

app.use(express.json());

// ---------------------------------------------------------------------------
// Admin authentication: every request to the sending endpoint must carry the
// shared secret configured in ADMIN_API_KEY. This keeps ordinary members from
// calling the API directly (the button that triggers this call only appears
// in the admin panel, but the endpoint itself must not trust the frontend).
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const configuredKey = process.env.ADMIN_API_KEY;
  if (!configuredKey) {
    return res.status(500).json({ success: false, message: 'WhatsApp API configuration সমস্যা।' });
  }
  const providedKey = req.header('X-Admin-Key');
  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({ success: false, message: 'অননুমোদিত অনুরোধ (Unauthorized)।' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Multer: accept a single PDF file up to the configured size cap, in memory
// (never written to disk — nothing about the receipt needs to persist server-side).
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: receipt.MAX_PDF_BYTES }
});

// Bangla, admin-friendly messages for every error path. Raw Graph API errors are
// logged server-side (see catch blocks) but never sent to the client verbatim.
const ERROR_MESSAGES = {
  WA_NOT_CONFIGURED: 'WhatsApp API configuration সমস্যা।',
  WA_INVALID_TOKEN: 'WhatsApp API configuration সমস্যা। (Access token অবৈধ/মেয়াদোত্তীর্ণ)',
  WA_MISSING_PERMISSION: 'WhatsApp API-তে প্রয়োজনীয় অনুমতি নেই।',
  WA_INVALID_PHONE: 'সদস্যের WhatsApp নম্বর সঠিক নয়।',
  WA_RECIPIENT_UNAVAILABLE: 'এই নম্বরে WhatsApp বার্তা পাঠানো যায়নি (নম্বরটি WhatsApp-এ সক্রিয় নেই)।',
  WA_TEMPLATE_REQUIRED: 'শেষ ২৪ ঘণ্টার মধ্যে সদস্যের সাথে কথোপকথন নেই — অনুমোদিত WhatsApp টেমপ্লেট প্রয়োজন।',
  WA_INVALID_MEDIA: 'PDF আপলোড করা যায়নি।',
  WA_MEDIA_UPLOAD_FAILED: 'PDF আপলোড করা যায়নি।',
  WA_RATE_LIMIT: 'অনুরোধের সংখ্যা সীমা ছাড়িয়ে গেছে, কিছুক্ষণ পর আবার চেষ্টা করুন।',
  WA_API_ERROR: 'ইন্টারনেট/API সংযোগ সমস্যা। আবার চেষ্টা করুন।'
};

app.get('/api/health', (req, res) => {
  res.json({ ok: true, configured: Boolean(process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN) });
});

app.post('/api/send-receipt', requireAdmin, upload.single('pdf'), async (req, res) => {
  try {
    const { phone: rawPhone, memberName, memberId, receiptNumber, month, amount, paymentDate } = req.body;

    // 1. Validate input -----------------------------------------------------
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'PDF ফাইল পাওয়া যায়নি।' });
    }
    if (!rawPhone || !memberName) {
      return res.status(400).json({ success: false, message: 'সদস্যের তথ্য অসম্পূর্ণ।' });
    }
    const phone = receipt.normalizePhone(rawPhone);
    if (!receipt.isPlausiblePhone(phone)) {
      return res.status(400).json({ success: false, message: ERROR_MESSAGES.WA_INVALID_PHONE });
    }

    // 2. Validate the PDF -----------------------------------------------------
    const pdfCheck = receipt.validatePdf(req.file.buffer);
    if (!pdfCheck.ok) {
      return res.status(400).json({ success: false, message: pdfCheck.message });
    }

    const filename = `Friends-Cooperative-${(memberId || '').replace(/[^A-Za-z0-9-]/g, '')}.pdf`;
    const caption = receipt.buildCaption({
      orgName: 'Friends Cooperative',
      memberName,
      memberId,
      month,
      amount
    });

    // 3. Upload the PDF to WhatsApp -----------------------------------------
    const mediaId = await whatsapp.uploadPdfMedia(req.file.buffer, filename);

    // 4. Send the document message -------------------------------------------
    let messageId;
    try {
      messageId = await whatsapp.sendDocumentMessage({ phone, mediaId, filename, caption });
    } catch (err) {
      // If WhatsApp requires an approved template (customer service window has
      // closed) and one is configured, retry as a template message automatically.
      if (err.code === 'WA_TEMPLATE_REQUIRED' && process.env.WA_TEMPLATE_NAME) {
        messageId = await whatsapp.sendTemplateWithDocument({
          phone,
          mediaId,
          filename,
          bodyParams: [memberName, memberId, month, amount, paymentDate, receiptNumber]
        });
      } else {
        throw err;
      }
    }

    return res.json({ success: true, message: 'PDF successfully sent to WhatsApp', messageId });
  } catch (err) {
    console.error('[send-receipt] failed:', err.code || '', err.message, err.graphError || '');
    const code = err.code && ERROR_MESSAGES[err.code] ? err.code : 'WA_API_ERROR';
    const status = code === 'WA_NOT_CONFIGURED' || code === 'WA_INVALID_TOKEN' ? 500 : 502;
    return res.status(status).json({ success: false, message: ERROR_MESSAGES[code] });
  }
});

// Multer errors (e.g. file too large) land here instead of the route handler above.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, message: 'PDF ফাইলের আকার অনেক বড়।' });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ success: false, message: 'ইন্টারনেট/API সংযোগ সমস্যা। আবার চেষ্টা করুন।' });
});

app.listen(PORT, () => {
  console.log(`Friends Cooperative WhatsApp backend listening on port ${PORT}`);
  if (!process.env.WA_PHONE_NUMBER_ID || !process.env.WA_ACCESS_TOKEN) {
    console.warn('⚠️  WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN are not set — sending will fail until .env is configured.');
  }
  if (!process.env.ADMIN_API_KEY) {
    console.warn('⚠️  ADMIN_API_KEY is not set — the endpoint will reject all requests until it is configured.');
  }
});
