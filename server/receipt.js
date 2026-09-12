'use strict';

const MAX_PDF_BYTES = 15 * 1024 * 1024; // WhatsApp's document size limit is 100MB; we cap well below that

/**
 * Validate the uploaded PDF buffer: present, non-empty, under the size cap, and
 * actually starts with the PDF magic bytes ("%PDF-"). Returns { ok, message }.
 */
function validatePdf(fileBuffer) {
  if (!fileBuffer || !fileBuffer.length) {
    return { ok: false, message: 'PDF তৈরি করা যায়নি।' };
  }
  if (fileBuffer.length > MAX_PDF_BYTES) {
    return { ok: false, message: 'PDF ফাইলের আকার অনেক বড়।' };
  }
  const header = fileBuffer.slice(0, 5).toString('utf8');
  if (header !== '%PDF-') {
    return { ok: false, message: 'অবৈধ PDF ফাইল।' };
  }
  return { ok: true };
}

/**
 * Normalize a phone number to the digits-only international format WhatsApp expects
 * (e.g. "974XXXXXXXX"). Does NOT guess or add a country code — the number must
 * already include one, matching the "don't auto-add a country code" requirement.
 */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  return digits;
}

function isPlausiblePhone(digits) {
  // International WhatsApp numbers are typically 8-15 digits including country code.
  return /^[0-9]{8,15}$/.test(digits);
}

/** Builds the Bangla caption sent alongside the PDF document. */
function buildCaption({ orgName, memberName, memberId, month, amount }) {
  const org = orgName || 'Friends Cooperative';
  const amt = formatTaka(amount);
  return [
    org,
    '',
    'আসসালামু আলাইকুম,',
    'আপনার সঞ্চয় জমার রসিদ সংযুক্ত করা হলো।',
    '',
    `সদস্য: ${memberName || ''}`,
    `Member ID: ${memberId || ''}`,
    month ? `মাস: ${month}` : null,
    `জমার পরিমাণ: ${amt} টাকা`,
    '',
    'ধন্যবাদ',
    org
  ].filter((line) => line !== null).join('\n');
}

function formatTaka(amount) {
  const n = Number(amount || 0);
  try {
    return new Intl.NumberFormat('bn-BD').format(n);
  } catch (e) {
    return String(n);
  }
}

module.exports = { validatePdf, normalizePhone, isPlausiblePhone, buildCaption, MAX_PDF_BYTES };
