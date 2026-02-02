import { describe, expect, test } from 'bun:test';
import type { SearchResult } from '../src/SearchEngine';

/**
 * Type/fixture tests: valid SearchResult with and without optional sizeInBytes
 * are accepted. Addons can return sizeInBytes from the search event.
 */
describe('SearchResult', () => {
  test('accepts result without sizeInBytes (torrent)', () => {
    const result: SearchResult = {
      name: 'Game Name',
      downloadType: 'torrent',
      filename: 'game.torrent',
      downloadURL: 'https://example.com/game.torrent',
    };
    expect(result.name).toBe('Game Name');
    expect(result.downloadType).toBe('torrent');
    expect('sizeInBytes' in result ? result.sizeInBytes : undefined).toBeUndefined();
  });

  test('accepts result with sizeInBytes (torrent)', () => {
    const result: SearchResult = {
      name: 'Game Name',
      downloadType: 'torrent',
      filename: 'game.torrent',
      downloadURL: 'https://example.com/game.torrent',
      sizeInBytes: 1024 * 1024 * 1024,
    };
    expect(result.name).toBe('Game Name');
    expect(result.sizeInBytes).toBe(1024 * 1024 * 1024);
  });

  test('accepts result without sizeInBytes (direct)', () => {
    const result: SearchResult = {
      name: 'Game Name',
      downloadType: 'direct',
      files: [{ name: 'game.zip', downloadURL: 'https://example.com/game.zip' }],
    };
    expect(result.downloadType).toBe('direct');
    expect(result.files).toHaveLength(1);
  });

  test('accepts result with sizeInBytes (request)', () => {
    const result: SearchResult = {
      name: 'Game Name',
      downloadType: 'request',
      sizeInBytes: 500 * 1024 * 1024,
    };
    expect(result.sizeInBytes).toBe(500 * 1024 * 1024);
  });
});
