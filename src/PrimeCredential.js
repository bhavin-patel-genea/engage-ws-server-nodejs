'use strict';

const crypto = require('crypto');

const UNSUPPORTED_FLAGS = [
  'is_parity_calculation_by_2_bits',
  'is_special_card_format',
  'is_large_encoded_id',
  'is_37_bit_special_parity_test',
  'is_37_bit_parity_test_with_4_bits',
  'is_37_bit_parity_test_with_2_bits',
  'is_200_bit_fascn_to_128_bit_version_conversation',
  'is_card_id_check_with_other_formats',
  'is_corporate_card',
  'enable_corporate_1000_parity_checks',
];

function parseBigInt(value, fieldName) {
  if (value === null || value === undefined || value === '') return 0n;
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(`${fieldName} must be an integer string`);
  }
  return BigInt(str);
}

function maxValueForBits(bitCount) {
  if (!bitCount || bitCount <= 0) return 0n;
  return (1n << BigInt(bitCount)) - 1n;
}

function bigintToFixedBitString(value, bitCount) {
  const max = maxValueForBits(bitCount);
  if (value < 0n || value > max) {
    throw new Error(`value ${value} exceeds ${bitCount} bits`);
  }
  return value.toString(2).padStart(bitCount, '0');
}

function setBits(bitArray, startBit, bitCount, value, fieldName) {
  if (!bitCount) return;
  if (startBit < 0 || startBit + bitCount > bitArray.length) {
    throw new Error(`${fieldName} bit range exceeds total card length`);
  }
  const bits = bigintToFixedBitString(value, bitCount);
  for (let i = 0; i < bits.length; i++) {
    bitArray[startBit + i] = bits[i] === '1' ? 1 : 0;
  }
}

function setEvenParity(bitArray, startBit, bitCount) {
  if (!bitCount) return;
  const parityBitIndex = startBit;
  let ones = 0;
  for (let i = startBit + 1; i < startBit + bitCount; i++) {
    ones += bitArray[i] || 0;
  }
  bitArray[parityBitIndex] = ones % 2;
}

function setOddParity(bitArray, startBit, bitCount) {
  if (!bitCount) return;
  const parityBitIndex = startBit + bitCount - 1;
  let ones = 0;
  for (let i = startBit; i < parityBitIndex; i++) {
    ones += bitArray[i] || 0;
  }
  bitArray[parityBitIndex] = ones % 2 === 0 ? 1 : 0;
}

function loadSiteKey(siteKeyHexOrBuffer) {
  if (Buffer.isBuffer(siteKeyHexOrBuffer)) return siteKeyHexOrBuffer;
  return Buffer.from(String(siteKeyHexOrBuffer).trim().slice(0, 64), 'hex');
}

function validateFormatSupport(format) {
  const payload = format?.payload || {};
  if (payload.format !== 'WIEGAND') {
    throw new Error(`Unsupported card format "${payload.format || 'unknown'}"`);
  }

  const enabledUnsupported = UNSUPPORTED_FLAGS.filter(flag => payload[flag]);
  if (enabledUnsupported.length > 0) {
    throw new Error(
      `Card format ${format.value || format.label || 'custom'} uses unsupported features: ` +
      enabledUnsupported.join(', ')
    );
  }
}

function validateFacilityCode(format, facilityCode) {
  const fc = format.fc;
  if (!fc) {
    if (facilityCode !== null && facilityCode !== undefined && facilityCode !== '') {
      throw new Error(`Card format ${format.value} does not use a facility code`);
    }
    return null;
  }

  if (facilityCode === null || facilityCode === undefined || facilityCode === '') {
    throw new Error(`Facility code is required for ${format.value}`);
  }

  const fcValue = parseBigInt(facilityCode, 'facilityCode');
  if (fcValue < BigInt(fc.min) || fcValue > BigInt(fc.max)) {
    throw new Error(`Facility code must be between ${fc.min} and ${fc.max}`);
  }
  return fcValue;
}

function buildRawCredentialBits(options) {
  const {
    format,
    cardNumber,
    facilityCode = null,
    issueCode = null,
  } = options;

  validateFormatSupport(format);

  const payload = format.payload;
  const totalBits = Number(payload.total_card_bits || 0);
  if (totalBits <= 0 || totalBits > 128) {
    throw new Error('total_card_bits must be between 1 and 128');
  }

  const cardValue = parseBigInt(cardNumber, 'cardNumber') + BigInt(payload.offset || 0);
  const fcValue = validateFacilityCode(format, facilityCode);
  const issueValue = parseBigInt(issueCode, 'issueCode');

  if (payload.min_number_of_digits > 0 && String(cardNumber).length < payload.min_number_of_digits) {
    throw new Error(`Card number must be at least ${payload.min_number_of_digits} digits`);
  }
  if (payload.max_number_of_digits > 0 && String(cardNumber).length > payload.max_number_of_digits) {
    throw new Error(`Card number must be at most ${payload.max_number_of_digits} digits`);
  }

  if (cardValue > maxValueForBits(Number(payload.total_cardholder_id_bits || 0))) {
    throw new Error(
      `Card number ${cardNumber} does not fit format ${format.value} ` +
      `(${payload.total_cardholder_id_bits} cardholder bits)`
    );
  }
  if (issueValue > maxValueForBits(Number(payload.total_issue_code_bits || 0))) {
    throw new Error(`Issue code does not fit ${payload.total_issue_code_bits} bits`);
  }

  const bitArray = new Array(totalBits).fill(0);
  setBits(bitArray, Number(payload.cardholder_id_start_bit || 0), Number(payload.total_cardholder_id_bits || 0), cardValue, 'cardholder');

  if (fcValue !== null) {
    setBits(
      bitArray,
      Number(payload.facility_code_start_bit || 0),
      Number(payload.total_facility_code_bits || 0),
      fcValue,
      'facility code'
    );
  }

  if (Number(payload.total_issue_code_bits || 0) > 0) {
    setBits(
      bitArray,
      Number(payload.issue_code_start_bit || 0),
      Number(payload.total_issue_code_bits || 0),
      issueValue,
      'issue code'
    );
  }

  setEvenParity(bitArray, Number(payload.even_parity_start_bit || 0), Number(payload.total_even_parity_bits || 0));
  setOddParity(bitArray, Number(payload.odd_parity_start_bit || 0), Number(payload.total_odd_parity_bits || 0));

  if (payload.is_reverse_card_format) {
    bitArray.reverse();
  }

  return bitArray;
}

function packPrimeClearBytes(bitArray, format) {
  let bitString = bitArray.join('');
  const padLength = (8 - (bitString.length % 8)) % 8;
  bitString += '0'.repeat(padLength);

  const bytes = [];
  for (let i = 0; i < bitString.length; i += 8) {
    bytes.push(parseInt(bitString.slice(i, i + 8), 2));
  }

  if (format.payload.is_reversal_of_bytes) {
    bytes.reverse();
  }

  if (bytes.length > 16) {
    throw new Error('PrimeCR exceeds 16 bytes');
  }

  const packed = Buffer.alloc(16, 0xFF);
  Buffer.from(bytes).copy(packed, 0);
  return packed;
}

function encryptPrimeClear(clearBuffer, siteKeyHexOrBuffer) {
  const siteKey = loadSiteKey(siteKeyHexOrBuffer);
  const cipher = crypto.createCipheriv('aes-256-cbc', siteKey, Buffer.alloc(16, 0));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(clearBuffer), cipher.final()]);
}

function generatePrimeCredential(options) {
  const bitArray = buildRawCredentialBits(options);
  const clearBuffer = packPrimeClearBytes(bitArray, options.format);
  const encryptedBuffer = encryptPrimeClear(clearBuffer, options.siteKey);

  return {
    bitLength: bitArray.length,
    rawBits: bitArray.join(''),
    clearBuffer,
    clearHex: clearBuffer.toString('hex'),
    encryptedBuffer,
    encryptedHex: encryptedBuffer.toString('hex'),
  };
}

function maskCardNumber(cardNumber) {
  const digits = String(cardNumber ?? '').trim();
  if (digits.length <= 4) return digits;
  return `****${digits.slice(-4)}`;
}

module.exports = {
  generatePrimeCredential,
  maskCardNumber,
  validateFormatSupport,
};
