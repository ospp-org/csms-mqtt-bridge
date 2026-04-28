import { describe, expect, it } from 'vitest';

import { __test__, ENVELOPE_VERSION } from '../redis.js';

const { parseOutgoingEnvelope } = __test__;

const validEnvelope = {
  version: 1,
  topic: 'ospp/v1/stations/stn_00000001/to-station',
  payload: Buffer.from('hello').toString('base64'),
  qos: 1,
};

describe('parseOutgoingEnvelope — happy paths', () => {
  it('parses a valid envelope', () => {
    const env = parseOutgoingEnvelope(JSON.stringify(validEnvelope));
    expect(env.version).toBe(ENVELOPE_VERSION);
    expect(env.topic).toBe('ospp/v1/stations/stn_00000001/to-station');
    expect(env.payload).toBe(Buffer.from('hello').toString('base64'));
    expect(env.qos).toBe(1);
    expect(env.properties).toBeUndefined();
  });

  it('parses an envelope with optional properties', () => {
    const env = parseOutgoingEnvelope(
      JSON.stringify({
        ...validEnvelope,
        properties: { contentType: 'application/json', userProperties: { traceId: 'abc' } },
      }),
    );
    expect(env.properties).toEqual({
      contentType: 'application/json',
      userProperties: { traceId: 'abc' },
    });
  });

  it.each([0, 1, 2] as const)('accepts qos=%s', (qos) => {
    const env = parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, qos }));
    expect(env.qos).toBe(qos);
  });
});

describe('parseOutgoingEnvelope — version', () => {
  it('rejects envelope missing version field', () => {
    const { version: _omit, ...withoutVersion } = validEnvelope;
    expect(() => parseOutgoingEnvelope(JSON.stringify(withoutVersion))).toThrow(
      /missing "version" field/,
    );
  });

  it('rejects envelope with wrong version (2)', () => {
    expect(() => parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, version: 2 }))).toThrow(
      /version mismatch.*got 2.*expected 1/,
    );
  });

  it('rejects envelope with string version', () => {
    expect(() => parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, version: '1' }))).toThrow(
      /version mismatch.*got "1".*expected 1/,
    );
  });

  it('rejects envelope with null version', () => {
    expect(() =>
      parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, version: null })),
    ).toThrow(/version mismatch.*got null.*expected 1/);
  });
});

describe('parseOutgoingEnvelope — required fields', () => {
  it('rejects non-object root (string)', () => {
    expect(() => parseOutgoingEnvelope(JSON.stringify('a string'))).toThrow(/not an object/);
  });

  it('rejects null root', () => {
    expect(() => parseOutgoingEnvelope('null')).toThrow(/not an object/);
  });

  it('rejects empty topic', () => {
    expect(() => parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, topic: '' }))).toThrow(
      /missing string "topic"/,
    );
  });

  it('rejects non-string topic', () => {
    expect(() => parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, topic: 123 }))).toThrow(
      /missing string "topic"/,
    );
  });

  it('rejects non-string payload', () => {
    expect(() => parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, payload: 123 }))).toThrow(
      /missing string "payload"/,
    );
  });

  it.each([3, -1, 1.5, 'high', null])('rejects invalid qos=%s', (qos) => {
    expect(() => parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, qos }))).toThrow(
      /qos.*must be 0, 1, or 2/,
    );
  });

  it('rejects non-object properties', () => {
    expect(() =>
      parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, properties: 'string' })),
    ).toThrow(/properties.*must be an object/);
  });

  it('rejects null properties (when present)', () => {
    expect(() =>
      parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, properties: null })),
    ).toThrow(/properties.*must be an object/);
  });
});
