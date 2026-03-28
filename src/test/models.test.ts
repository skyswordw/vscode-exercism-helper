import { describe, it, expect } from 'vitest';
import { slugToName } from '../models/exercise';

describe('slugToName', () => {
  it('converts "hello-world" to "Hello World"', () => {
    expect(slugToName('hello-world')).toBe('Hello World');
  });

  it('converts "two-fer" to "Two Fer"', () => {
    expect(slugToName('two-fer')).toBe('Two Fer');
  });

  it('converts single word "simple" to "Simple"', () => {
    expect(slugToName('simple')).toBe('Simple');
  });

  it('returns empty string for empty input', () => {
    expect(slugToName('')).toBe('');
  });
});
