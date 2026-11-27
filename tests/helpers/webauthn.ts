import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

/**
 * Minimal synthetic authenticator used only by tests.
 *
 * It generates a real P-256 key, produces a WebAuthn attestation object in the
 * "none" format and signs authentication assertions. That lets the test suite
 * exercise the real @simplewebauthn verification path without a browser.
 */

const encoder = new TextEncoder();

export function b64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function head(major: number, length: number) {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length < 256) return Uint8Array.of((major << 5) | 24, length);
  if (length < 65_536) return Uint8Array.of((major << 5) | 25, (length >> 8) & 0xff, length & 0xff);
  return Uint8Array.of(
    (major << 5) | 26,
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
  );
}

const cborInt = (value: number) => (value >= 0 ? head(0, value) : head(1, -1 - value));
const cborBytes = (value: Uint8Array) => concat(head(2, value.length), value);
const cborText = (value: string) => {
  const bytes = encoder.encode(value);
  return concat(head(3, bytes.length), bytes);
};
const cborMap = (entries: Array<[Uint8Array, Uint8Array]>) =>
  concat(head(5, entries.length), ...entries.flat());

const sha256 = async (value: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", value));

function derInteger(value: Uint8Array) {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.slice(start);
  return trimmed[0] & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
}

function derSignature(raw: Uint8Array) {
  if (raw.length !== 64) throw new Error("Unexpected ECDSA signature length");
  const r = derInteger(raw.slice(0, 32));
  const s = derInteger(raw.slice(32));
  const body = concat(Uint8Array.of(0x02, r.length), r, Uint8Array.of(0x02, s.length), s);
  return concat(Uint8Array.of(0x30, body.length), body);
}

function authData(rpIdHash: Uint8Array, flags: number, counter: number, extra?: Uint8Array) {
  const counterBytes = Uint8Array.of(
    (counter >>> 24) & 0xff,
    (counter >>> 16) & 0xff,
    (counter >>> 8) & 0xff,
    counter & 0xff,
  );
  return concat(rpIdHash, Uint8Array.of(flags), counterBytes, extra ?? new Uint8Array());
}

export type VirtualAuthenticator = {
  credentialId: Uint8Array;
  registration: (challenge: string) => RegistrationResponseJSON;
  assertion: (challenge: string, userHandle: Uint8Array) => Promise<AuthenticationResponseJSON>;
};

export async function virtualAuthenticator(
  rpID: string,
  origin: string,
): Promise<VirtualAuthenticator> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPublicKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  if (rawPublicKey.length !== 65 || rawPublicKey[0] !== 0x04)
    throw new Error("Unexpected P-256 public key");
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const rpIdHash = await sha256(encoder.encode(rpID));
  const coseKey = cborMap([
    [cborInt(1), cborInt(2)],
    [cborInt(3), cborInt(-7)],
    [cborInt(-1), cborInt(1)],
    [cborInt(-2), cborBytes(rawPublicKey.slice(1, 33))],
    [cborInt(-3), cborBytes(rawPublicKey.slice(33, 65))],
  ]);
  let counter = 0;

  return {
    credentialId,
    registration(challenge) {
      const clientDataJSON = b64url(
        encoder.encode(
          JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }),
        ),
      );
      const attestedCredentialData = concat(
        new Uint8Array(16),
        Uint8Array.of((credentialId.length >> 8) & 0xff, credentialId.length & 0xff),
        credentialId,
        coseKey,
      );
      // UP + UV + AT: user present, user verified, attested credential included.
      const data = authData(rpIdHash, 0x45, 0, attestedCredentialData);
      const attestationObject = b64url(
        cborMap([
          [cborText("fmt"), cborText("none")],
          [cborText("attStmt"), cborMap([])],
          [cborText("authData"), cborBytes(data)],
        ]),
      );
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON,
          attestationObject,
          transports: ["internal"],
        },
      } as unknown as RegistrationResponseJSON;
    },
    async assertion(challenge, userHandle) {
      counter += 1;
      const clientData = encoder.encode(
        JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }),
      );
      const clientDataJSON = b64url(clientData);
      const data = authData(rpIdHash, 0x05, counter);
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          concat(data, await sha256(clientData)),
        ),
      );
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON,
          authenticatorData: b64url(data),
          signature: b64url(derSignature(signature)),
          userHandle: b64url(userHandle),
        },
      } as unknown as AuthenticationResponseJSON;
    },
  };
}
