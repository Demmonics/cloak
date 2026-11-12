import { describe, expect, it } from 'vitest';
import {
  CryptoOperationError,
  decryptAttachmentChunks,
  decryptMessageCiphertext,
  encryptAttachmentChunks,
  encryptMessageBody,
  exportEncryptedDeviceBackup,
  fromBase64Std,
  generateDeviceIdentity,
  generateRoomEpochKey,
  importEncryptedDeviceBackup,
  signAuthChallenge,
  signRegistrationProof,
  unwrapEpochKeyEnvelope,
  unwrapRoomKeyFromInvite,
  verifyDetachedSignature,
  wrapEpochKeyForRecipient,
  wrapRoomKeyForInvite,
  utf8Encode,
} from './index.js';

describe('@cloak/crypto', () => {
  it('generates anonymous device identities and verifies registration & auth proofs', async () => {
    const bundle = await generateDeviceIdentity();
    expect(bundle.deviceId).toMatch(/^[0-9a-f-]{36}$/);

    const regSig = await signRegistrationProof(bundle);
    const canonicalReg = `cloak-register-v1:${bundle.deviceId}:${bundle.ed25519PublicKeyB64}:${bundle.x25519PublicKeyB64}`;
    expect(await verifyDetachedSignature(utf8Encode(canonicalReg), regSig, bundle.ed25519PublicKeyB64)).toBe(true);
    expect(await verifyDetachedSignature(utf8Encode(canonicalReg + 'x'), regSig, bundle.ed25519PublicKeyB64)).toBe(false);

    const authSig = await signAuthChallenge(bundle, 'challenge-123', 'bm9uY2U=');
    const canonicalAuth = `cloak-auth-v1:challenge-123:bm9uY2U=:${bundle.deviceId}`;
    expect(await verifyDetachedSignature(utf8Encode(canonicalAuth), authSig, bundle.ed25519PublicKeyB64)).toBe(true);
  });

  it('exports and imports encrypted device key backups using Argon2id + XChaCha20-Poly1305', async () => {
    const bundle = await generateDeviceIdentity();
    const backup = await exportEncryptedDeviceBackup(bundle, 'correct-horse-battery-99', {
      opslimit: 2,
      memlimitBytes: 8 * 1024 * 1024,
    });

    const restored = await importEncryptedDeviceBackup(backup, 'correct-horse-battery-99');
    expect(restored).toEqual(bundle);

    await expect(importEncryptedDeviceBackup(backup, 'wrong-passphrase')).rejects.toThrow(CryptoOperationError);
  });

  it('wraps and unwraps room epoch keys while binding room, epoch, and recipient identity', async () => {
    const alice = await generateDeviceIdentity();
    const bob = await generateDeviceIdentity();
    const epochKey = await generateRoomEpochKey();

    const wrapped = await wrapEpochKeyForRecipient({
      roomId: 'room-1',
      epoch: 1,
      recipientDeviceId: bob.deviceId,
      recipientX25519PublicKeyB64: bob.x25519PublicKeyB64,
      senderDeviceId: alice.deviceId,
      senderX25519SecretKeyB64: alice.x25519SecretKeyB64,
      epochKey,
    });

    const unwrapped = await unwrapEpochKeyEnvelope({
      envelope: {
        id: 'env-1',
        roomId: 'room-1',
        epoch: 1,
        recipientDeviceId: bob.deviceId,
        senderDeviceId: alice.deviceId,
        senderX25519PublicKeyB64: alice.x25519PublicKeyB64,
        wrappedKeyCiphertextB64: wrapped,
      },
      expectedRoomId: 'room-1',
      expectedRecipientDeviceId: bob.deviceId,
      recipientX25519SecretKeyB64: bob.x25519SecretKeyB64,
    });

    expect(unwrapped).toEqual(epochKey);

    await expect(
      unwrapEpochKeyEnvelope({
        envelope: {
          id: 'env-1',
          roomId: 'room-1',
          epoch: 1,
          recipientDeviceId: bob.deviceId,
          senderDeviceId: alice.deviceId,
          senderX25519PublicKeyB64: alice.x25519PublicKeyB64,
          wrappedKeyCiphertextB64: wrapped,
        },
        expectedRoomId: 'room-other',
        expectedRecipientDeviceId: bob.deviceId,
        recipientX25519SecretKeyB64: bob.x25519SecretKeyB64,
      }),
    ).rejects.toThrow(CryptoOperationError);
  });

  it('wraps invite keys both without password and with Argon2id+secret joint password', async () => {
    const epochKey = await generateRoomEpochKey();

    const openInvite = await wrapRoomKeyForInvite({ roomId: 'room-a', epoch: 1, epochKey });
    expect(fromBase64Std(openInvite.wrappedRoomKeyBlobB64).byteLength).toBeLessThanOrEqual(512);
    const recoveredOpen = await unwrapRoomKeyFromInvite({
      roomId: 'room-a',
      epoch: 1,
      wrappedRoomKeyBlobB64: openInvite.wrappedRoomKeyBlobB64,
      linkSecretB64Url: openInvite.linkSecretB64Url,
    });
    expect(recoveredOpen).toEqual(epochKey);

    const pwInvite = await wrapRoomKeyForInvite({
      roomId: 'room-a',
      epoch: 2,
      epochKey,
      password: 'secret-invite-pass',
    });
    expect(fromBase64Std(pwInvite.wrappedRoomKeyBlobB64).byteLength).toBeLessThanOrEqual(512);

    await expect(
      unwrapRoomKeyFromInvite({
        roomId: 'room-a',
        epoch: 2,
        wrappedRoomKeyBlobB64: pwInvite.wrappedRoomKeyBlobB64,
        linkSecretB64Url: pwInvite.linkSecretB64Url,
      }),
    ).rejects.toThrow(CryptoOperationError);

    await expect(
      unwrapRoomKeyFromInvite({
        roomId: 'room-a',
        epoch: 2,
        wrappedRoomKeyBlobB64: pwInvite.wrappedRoomKeyBlobB64,
        linkSecretB64Url: pwInvite.linkSecretB64Url,
        password: 'wrong-password',
      }),
    ).rejects.toThrow(CryptoOperationError);

    const recoveredPw = await unwrapRoomKeyFromInvite({
      roomId: 'room-a',
      epoch: 2,
      wrappedRoomKeyBlobB64: pwInvite.wrappedRoomKeyBlobB64,
      linkSecretB64Url: pwInvite.linkSecretB64Url,
      password: 'secret-invite-pass',
    });
    expect(recoveredPw).toEqual(epochKey);
  });

  it('encrypts messages with canonical AAD binding and Ed25519 sender signature', async () => {
    const alice = await generateDeviceIdentity();
    const epochKey = await generateRoomEpochKey();

    const ciphertextB64 = await encryptMessageBody({
      roomId: 'room-1',
      channelId: 'chan-1',
      messageId: 'msg-1',
      encryptionEpoch: 1,
      epochKey,
      senderBundle: alice,
      body: { version: 1, text: 'Hello encrypted Cloak!' },
    });

    const decrypted = await decryptMessageCiphertext({
      roomId: 'room-1',
      channelId: 'chan-1',
      messageId: 'msg-1',
      senderDeviceId: alice.deviceId,
      encryptionEpoch: 1,
      epochKey,
      ciphertextB64,
      senderEd25519PublicKeyB64: alice.ed25519PublicKeyB64,
    });
    expect(decrypted.body.text).toBe('Hello encrypted Cloak!');
    expect(decrypted.signatureVerified).toBe(true);

    // Channel substitution fails AEAD authentication
    await expect(
      decryptMessageCiphertext({
        roomId: 'room-1',
        channelId: 'chan-other',
        messageId: 'msg-1',
        senderDeviceId: alice.deviceId,
        encryptionEpoch: 1,
        epochKey,
        ciphertextB64,
      }),
    ).rejects.toThrow(CryptoOperationError);
  });

  it('encrypts and authenticates multi-chunk attachments and rejects truncation or reordering', async () => {
    const data = new Uint8Array(2500);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

    const enc = await encryptAttachmentChunks(data, 1000);
    expect(enc.encryptedChunks.length).toBe(3);

    const dec = await decryptAttachmentChunks({
      encryptedChunks: enc.encryptedChunks,
      fileKeyB64: enc.fileKeyB64,
      streamHeaderB64: enc.streamHeaderB64,
      expectedPlaintextSha256Hex: enc.plaintextSha256Hex,
    });
    expect(dec).toEqual(data);

    // Truncated stream fails before TAG_FINAL
    await expect(
      decryptAttachmentChunks({
        encryptedChunks: enc.encryptedChunks.slice(0, 2),
        fileKeyB64: enc.fileKeyB64,
        streamHeaderB64: enc.streamHeaderB64,
      }),
    ).rejects.toThrow(CryptoOperationError);

    // Reordered chunks fail per-chunk AAD authentication
    await expect(
      decryptAttachmentChunks({
        encryptedChunks: [enc.encryptedChunks[1]!, enc.encryptedChunks[0]!, enc.encryptedChunks[2]!],
        fileKeyB64: enc.fileKeyB64,
        streamHeaderB64: enc.streamHeaderB64,
      }),
    ).rejects.toThrow(CryptoOperationError);
  });
});

