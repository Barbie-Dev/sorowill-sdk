import { describe, expect, it } from 'vitest';
import { createReadCacheKey, escapeKeyComponent, escapeCacheKeyComponent } from '../src/cache';

describe('Issue #562: Cache key escaping and collision prevention', () => {
  it('exports escapeKeyComponent and escapeCacheKeyComponent', () => {
    expect(typeof escapeKeyComponent).toBe('function');
    expect(escapeCacheKeyComponent).toBe(escapeKeyComponent);
  });

  it('escapes colons in component IDs to prevent delimiter ambiguity', () => {
    expect(escapeKeyComponent('get:will')).toBe('get%3Awill');
    expect(escapeKeyComponent('owner:123:history')).toBe('owner%3A123%3Ahistory');
  });

  it('escapes consecutive colons and other common separators', () => {
    expect(escapeKeyComponent('namespace::method')).toBe('namespace%3A%3Amethod');
    expect(escapeKeyComponent('path/to/resource')).toBe('path%2Fto%2Fresource');
    expect(escapeKeyComponent('query?arg=1&val=2')).toBe('query%3Farg%3D1%26val%3D2');
    expect(escapeKeyComponent('item#section;part')).toBe('item%23section%3Bpart');
    expect(escapeKeyComponent('a,b,c')).toBe('a%2Cb%2Cc');
    expect(escapeKeyComponent('back\\slash')).toBe('back%5Cslash');
    expect(escapeKeyComponent('space id')).toBe('space%20id');
  });

  it('escapes percent signs so encoded strings do not collide with raw strings', () => {
    // If a component contains '%3A', escaping it yields '%253A', so it cannot collide with ':' which escapes to '%3A'
    const rawColon = escapeKeyComponent('a:b');
    const rawEncoded = escapeKeyComponent('a%3Ab');
    expect(rawColon).toBe('a%3Ab');
    expect(rawEncoded).toBe('a%253Ab');
    expect(rawColon).not.toBe(rawEncoded);
  });

  it('prevents collisions between different method/argument combinations', () => {
    // Without escaping, method 'get:will' with args {} and method 'get' with args containing 'will'
    // or method containing colons could collide.
    const key1 = createReadCacheKey('get:will', { id: '1' });
    const key2 = createReadCacheKey('get', { will: { id: '1' } });
    const key3 = createReadCacheKey('get%3Awill', { id: '1' });

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key2).not.toBe(key3);

    expect(key1).toBe('get%3Awill:{"id":"1"}');
    expect(key3).toBe('get%253Awill:{"id":"1"}');
  });

  it('preserves clean method names without modification', () => {
    expect(createReadCacheKey('get_will', { willId: '10' })).toBe('get_will:{"willId":"10"}');
    expect(createReadCacheKey('get_wills_by_owner', { owner: 'G123' })).toBe(
      'get_wills_by_owner:{"owner":"G123"}',
    );
  });

  it('handles edge cases: empty strings, unicode, emojis, control characters', () => {
    expect(escapeKeyComponent('')).toBe('');
    expect(createReadCacheKey('', {})).toBe(':{}');

    const unicodeKey = createReadCacheKey('café:über', { key: 'val' });
    expect(unicodeKey).toContain('caf%C3%A9%3A%C3%BCber');

    const emojiKey = createReadCacheKey('🔑:🔒', { active: true });
    expect(emojiKey).toContain('%F0%9F%94%91%3A%F0%9F%94%92');
  });
});
