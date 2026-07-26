const { createHash } = require('node:crypto');

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function createIncrementalPatch(base, target, versions) {
  if (!Buffer.isBuffer(base) || !Buffer.isBuffer(target)) {
    throw new Error('Incremental patch inputs must be buffers');
  }
  let prefixBytes = 0;
  while (
    prefixBytes < base.length &&
    prefixBytes < target.length &&
    base[prefixBytes] === target[prefixBytes]
  ) {
    prefixBytes += 1;
  }
  let suffixBytes = 0;
  while (
    suffixBytes < base.length - prefixBytes &&
    suffixBytes < target.length - prefixBytes &&
    base[base.length - suffixBytes - 1] ===
      target[target.length - suffixBytes - 1]
  ) {
    suffixBytes += 1;
  }
  return {
    version: 1,
    fromVersion: versions.fromVersion,
    toVersion: versions.toVersion,
    baseSize: base.length,
    baseSha256: sha256(base),
    targetSize: target.length,
    targetSha256: sha256(target),
    prefixBytes,
    suffixBytes,
    replacement: target
      .subarray(prefixBytes, target.length - suffixBytes)
      .toString('base64'),
  };
}

function assertHexDigest(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Incremental patch ${name} is invalid`);
  }
}

function applyIncrementalPatch(base, patch) {
  if (!Buffer.isBuffer(base)) {
    throw new Error('Incremental patch base must be a buffer');
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Incremental patch metadata is invalid');
  }
  const keys = [
    'version',
    'fromVersion',
    'toVersion',
    'baseSize',
    'baseSha256',
    'targetSize',
    'targetSha256',
    'prefixBytes',
    'suffixBytes',
    'replacement',
  ];
  const unknown = Object.keys(patch).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in patch));
  if (unknown.length > 0 || missing.length > 0 || patch.version !== 1) {
    throw new Error('Incremental patch metadata is invalid');
  }
  if (
    typeof patch.fromVersion !== 'string' ||
    typeof patch.toVersion !== 'string' ||
    !Number.isSafeInteger(patch.baseSize) ||
    !Number.isSafeInteger(patch.targetSize) ||
    !Number.isSafeInteger(patch.prefixBytes) ||
    !Number.isSafeInteger(patch.suffixBytes) ||
    typeof patch.replacement !== 'string'
  ) {
    throw new Error('Incremental patch metadata is invalid');
  }
  assertHexDigest(patch.baseSha256, 'base checksum');
  assertHexDigest(patch.targetSha256, 'target checksum');
  if (base.length !== patch.baseSize || sha256(base) !== patch.baseSha256) {
    throw new Error('Incremental patch base checksum does not match');
  }
  if (
    patch.prefixBytes < 0 ||
    patch.suffixBytes < 0 ||
    patch.prefixBytes + patch.suffixBytes > base.length
  ) {
    throw new Error('Incremental patch ranges are invalid');
  }
  const replacement = Buffer.from(patch.replacement, 'base64');
  const target = Buffer.concat([
    base.subarray(0, patch.prefixBytes),
    replacement,
    base.subarray(base.length - patch.suffixBytes),
  ]);
  if (
    target.length !== patch.targetSize ||
    sha256(target) !== patch.targetSha256
  ) {
    throw new Error('Incremental patch target checksum does not match');
  }
  return target;
}

module.exports = { applyIncrementalPatch, createIncrementalPatch, sha256 };
