import fs from 'fs';
import { createHash } from 'crypto';

/**
 * Returns a composite key combining a block checksum and size.
 * Used to disambiguate blocks that share the same checksum but differ in size.
 *
 * @param {string} checksum
 * @param {number} size
 * @returns {string}
 */
export function getBlockKey(checksum, size) {
  return `${checksum}:${size}`;
}

/**
 * Pops and returns the last block from a blocks array, consuming it.
 * Returns null if the array is empty or not an array.
 *
 * @param {Array<{offset: number, size: number}>|null|undefined} blocks
 * @returns {{offset: number, size: number}|null}
 */
export function takeMatchingBlock(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return null;
  }
  return blocks.pop();
}

/**
 * Parses a digest string of the form "algorithm:hexvalue".
 * Supported algorithms: sha256, sha384, sha512.
 *
 * @param {string} digest
 * @returns {{algorithm: string, value: string}|null}
 */
export function parseDigest(digest) {
  if (typeof digest !== 'string') {
    return null;
  }
  const [algorithm, value] = digest.split(':', 2);
  if (!algorithm || !value) {
    return null;
  }
  const normalizedAlgorithm = algorithm.toLowerCase();
  if (
    normalizedAlgorithm !== 'sha256' &&
    normalizedAlgorithm !== 'sha384' &&
    normalizedAlgorithm !== 'sha512'
  ) {
    return null;
  }
  return { algorithm: normalizedAlgorithm, value: value.toLowerCase() };
}

/**
 * Hashes a file using the given algorithm and returns the hex digest.
 *
 * @param {string} filePath
 * @param {string} algorithm
 * @returns {Promise<string>}
 */
export async function hashFile(filePath, algorithm) {
  return await new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Verifies a release artifact on disk against expected size and digest.
 * Throws on size mismatch. Throws on digest mismatch if a valid digest is provided.
 * Logs and returns silently if no valid digest is available.
 *
 * @param {string} artifactPath  - Absolute path to the artifact file.
 * @param {{size?: number, digest?: string}} expectedArtifact
 * @param {string} [logLabel]
 */
export async function verifyReleaseArtifact(
  artifactPath,
  expectedArtifact,
  logLabel = 'release artifact'
) {
  const stat = fs.statSync(artifactPath);
  if (
    Number.isFinite(expectedArtifact.size) &&
    expectedArtifact.size > 0 &&
    stat.size !== expectedArtifact.size
  ) {
    throw new Error(
      `${logLabel} size mismatch: expected ${expectedArtifact.size}, got ${stat.size}`
    );
  }

  const parsedDigest = parseDigest(expectedArtifact.digest);
  if (!parsedDigest) {
    return;
  }

  const actualDigest = await hashFile(artifactPath, parsedDigest.algorithm);
  if (actualDigest !== parsedDigest.value) {
    throw new Error(`${logLabel} digest mismatch for ${parsedDigest.algorithm}`);
  }
}