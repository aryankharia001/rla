import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { ZOOM_VIDEO_SDK_KEY, ZOOM_VIDEO_SDK_SECRET, ZOOM_WEBHOOK_SECRET_TOKEN } from '../../config/env.js';
import type {
  IVideoProvider,
  GenerateTokenParams,
  VideoSessionTokenResult,
  WebhookValidationResult,
} from './IVideoProvider.js';

export class ZoomVideoSdkProvider implements IVideoProvider {
  public readonly name = 'ZoomVideoSDK';

  private sdkKey: string;
  private sdkSecret: string;

  constructor() {
    this.sdkKey = ZOOM_VIDEO_SDK_KEY;
    this.sdkSecret = ZOOM_VIDEO_SDK_SECRET;
  }

  /**
   * Generates a signed Zoom Video SDK JWT token.
   * Role 1 = Host (Faculty), Role 0 = Attendee (Student)
   */
  public async generateToken(params: GenerateTokenParams): Promise<VideoSessionTokenResult> {
    if (!this.sdkKey || !this.sdkSecret || this.sdkSecret.startsWith('mock_')) throw new Error('Zoom Video SDK credentials are not configured.');
    const {
      sessionTopic,
      userId,
      roleType,
      durationMinutes = 120,
      cloudRecordingOption = 1,
    } = params;

    const epochNow = Math.floor(Date.now() / 1000);
    // Token is valid for scheduled duration + 2 hours buffer
    const expirationSeconds = epochNow + durationMinutes * 60 + 7200;

    const payload = {
      app_key: this.sdkKey,
      version: 1,
      user_identity: String(userId),
      iat: epochNow,
      exp: expirationSeconds,
      tpc: sessionTopic,
      role_type: roleType,
      cloud_recording_option: cloudRecordingOption,
      cloud_recording_election: 1,
    };

    const token = jwt.sign(payload, this.sdkSecret, {
      algorithm: 'HS256',
    });

    return {
      token,
      sessionTopic,
      roleType,
      expiresAt: expirationSeconds,
    };
  }

  /**
   * Challenge-Response Check (CRC) for Zoom Webhook URL Validation
   */
  public handleCrcChallenge(plainToken: string): { plainToken: string; encryptedToken: string } {
    if (!ZOOM_WEBHOOK_SECRET_TOKEN || typeof plainToken !== 'string') throw new Error('Zoom webhook secret or challenge is missing.');
    const encryptedToken = crypto
      .createHmac('sha256', ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(plainToken)
      .digest('hex');

    return {
      plainToken,
      encryptedToken,
    };
  }

  /**
   * Verifies incoming Zoom Webhook signatures (x-zm-signature & x-zm-request-timestamp)
   */
  public verifyWebhook(headers: Record<string, any>, rawBody: string | any): WebhookValidationResult {
    try {
      const timestamp = headers['x-zm-request-timestamp'] || headers['x-zm-timestamp'];
      const signature = headers['x-zm-signature'];

      const bodyObj = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
      const eventName = bodyObj?.event || bodyObj?.payload?.event;

      if (!ZOOM_WEBHOOK_SECRET_TOKEN || typeof rawBody !== 'string') return { isValid: false, error: 'Zoom webhook verification is not configured.' };

      if (!timestamp || !signature) {
        return {
          isValid: false,
          error: 'Missing Zoom webhook headers (timestamp or signature).',
        };
      }
      const timestampSeconds = Number(timestamp);
      if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return { isValid: false, error: 'Expired Zoom webhook timestamp.' };

      const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
      const message = `v0:${timestamp}:${bodyStr}`;
      const expectedSignature =
        'v0=' + crypto.createHmac('sha256', ZOOM_WEBHOOK_SECRET_TOKEN).update(message).digest('hex');

      const received = Buffer.from(String(signature));
      const expected = Buffer.from(expectedSignature);
      if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
        return {
          isValid: false,
          error: 'Invalid Zoom webhook HMAC signature.',
        };
      }

      return {
        isValid: true,
        event: eventName,
        payload: bodyObj?.payload || bodyObj,
      };
    } catch (err: any) {
      return {
        isValid: false,
        error: err.message || 'Failed to verify webhook payload.',
      };
    }
  }
}

// Export singleton instance
export const zoomVideoProvider = new ZoomVideoSdkProvider();
export default zoomVideoProvider;
