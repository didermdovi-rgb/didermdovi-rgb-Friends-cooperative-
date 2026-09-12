'use strict';

/**
 * Thin wrapper around the official Meta WhatsApp Business Cloud API.
 * Two calls are needed to deliver a PDF as a WhatsApp document message:
 *   1. Upload the PDF bytes to WhatsApp's media endpoint -> get back a media id.
 *   2. Send a "document" message referencing that media id to the recipient.
 *
 * The access token and phone number id are read from environment variables only —
 * they are never accepted from the frontend and never logged.
 */

function graphBaseUrl() {
  const version = process.env.GRAPH_API_VERSION || 'v20.0';
  return `https://graph.facebook.com/${version}`;
}

function assertConfigured() {
  const missing = [];
  if (!process.env.WA_PHONE_NUMBER_ID) missing.push('WA_PHONE_NUMBER_ID');
  if (!process.env.WA_ACCESS_TOKEN) missing.push('WA_ACCESS_TOKEN');
  if (missing.length) {
    const err = new Error(`WhatsApp API is not configured. Missing: ${missing.join(', ')}`);
    err.code = 'WA_NOT_CONFIGURED';
    throw err;
  }
}

/**
 * Upload a PDF buffer to WhatsApp's media endpoint.
 * Returns the WhatsApp media id used to reference the file in the next call.
 */
async function uploadPdfMedia(pdfBuffer, filename) {
  assertConfigured();
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const url = `${graphBaseUrl()}/${phoneNumberId}/media`;

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), filename || 'receipt.pdf');
  form.append('type', 'application/pdf');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`
    },
    body: form
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    const err = new Error(describeGraphError(data, 'PDF upload failed'));
    err.code = 'WA_MEDIA_UPLOAD_FAILED';
    err.graphError = data;
    throw err;
  }
  return data.id;
}

/**
 * Send a previously-uploaded document (by media id) to a phone number, with a caption.
 */
async function sendDocumentMessage({ phone, mediaId, filename, caption }) {
  assertConfigured();
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const url = `${graphBaseUrl()}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'document',
    document: {
      id: mediaId,
      filename: filename || 'receipt.pdf',
      caption: caption || ''
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.messages || !data.messages[0]) {
    const err = new Error(describeGraphError(data, 'Sending the document message failed'));
    err.code = classifyGraphError(data);
    err.graphError = data;
    throw err;
  }
  return data.messages[0].id;
}

/**
 * Send an approved template message (needed when messaging a member outside the
 * 24-hour customer service window, per WhatsApp Business policy). Only used if
 * WA_TEMPLATE_NAME is configured; otherwise callers should use sendDocumentMessage.
 * The template is expected to accept the PDF as a "document" header component.
 */
async function sendTemplateWithDocument({ phone, mediaId, filename, bodyParams }) {
  assertConfigured();
  const templateName = process.env.WA_TEMPLATE_NAME;
  if (!templateName) {
    const err = new Error('No approved WhatsApp template is configured (WA_TEMPLATE_NAME).');
    err.code = 'WA_TEMPLATE_REQUIRED';
    throw err;
  }
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const url = `${graphBaseUrl()}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: process.env.WA_TEMPLATE_LANGUAGE || 'bn' },
      components: [
        {
          type: 'header',
          parameters: [{ type: 'document', document: { id: mediaId, filename: filename || 'receipt.pdf' } }]
        },
        {
          type: 'body',
          parameters: (bodyParams || []).map((text) => ({ type: 'text', text: String(text) }))
        }
      ]
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.messages || !data.messages[0]) {
    const err = new Error(describeGraphError(data, 'Sending the template message failed'));
    err.code = classifyGraphError(data);
    err.graphError = data;
    throw err;
  }
  return data.messages[0].id;
}

function describeGraphError(data, fallback) {
  const msg = data && data.error && (data.error.error_user_msg || data.error.message);
  return msg || fallback;
}

/** Maps a Graph API error payload to one of our stable error codes (see server.js ERROR_MESSAGES). */
function classifyGraphError(data) {
  const err = (data && data.error) || {};
  const code = err.code;
  const subcode = err.error_subcode;
  const type = err.type;

  if (code === 190) return 'WA_INVALID_TOKEN'; // expired/invalid access token
  if (code === 200 || code === 10) return 'WA_MISSING_PERMISSION';
  if (code === 131030 || code === 131026) return 'WA_RECIPIENT_UNAVAILABLE'; // not a WhatsApp user / not in allowed list
  if (code === 131047) return 'WA_TEMPLATE_REQUIRED'; // re-engagement / outside 24h window
  if (code === 131009 || subcode === 2494010) return 'WA_INVALID_PHONE';
  if (code === 131053) return 'WA_INVALID_MEDIA';
  if (code === 80007 || type === 'OAuthException' && code === 4) return 'WA_RATE_LIMIT';
  return 'WA_API_ERROR';
}

module.exports = {
  uploadPdfMedia,
  sendDocumentMessage,
  sendTemplateWithDocument,
  classifyGraphError
};
