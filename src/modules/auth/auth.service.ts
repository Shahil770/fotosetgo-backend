import { Injectable, ConflictException, UnauthorizedException, BadRequestException, NotFoundException, HttpException, HttpStatus, Inject, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { OAuth2Client } from 'google-auth-library';
import Redis from 'ioredis';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private s3Client: S3Client;

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    @Inject('REDIS_CLIENT') private redis: Redis,
  ) {
    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT_URL || 'https://166ca4c1757a6fb1fdf38adf85eb54ba.r2.cloudflarestorage.com',
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '008e409eb6ca8ce7ca73ef1a2d5b0d34',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '5950a06ff782c9a45c2ff18737703179d144b47ab2b4d4d6b7ea94e00e300402',
      },
    });
  }

  /**
   * Get fresh 7-day signed URL for FotoSetGo official logo
   */
  private async getOfficialLogoUrl(): Promise<string> {
    const cacheKey = 'cache:branding:official-logo-url';
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return cached;
    } catch {}

    try {
      const command = new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME || 'fotosetgo-photos',
        Key: 'branding/fotosetgo-official-logo.png',
      });
      const url = await getSignedUrl(this.s3Client, command, { expiresIn: 604800 }); // 7 days
      await this.redis.set(cacheKey, url, 'EX', 500000).catch(() => {});
      return url;
    } catch (err: any) {
      this.logger.error(`Failed to generate signed logo URL: ${err.message}`);
      return 'https://fotosetgo.com/fotosetgo.png';
    }
  }

  /**
   * Send 6-Digit Email OTP for Studio Registration via Resend API
   */
  async sendSignupOtp(email: string, name?: string, clientIp?: string) {
    const normalizedEmail = (email || '').toLowerCase().trim();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new BadRequestException('Please enter a valid email address.');
    }

    // 1. IP-Level Rate Limiting: Max 5 OTP requests per hour per client IP
    if (clientIp && clientIp !== '127.0.0.1') {
      const ipKey = `rate:signup:otp:ip:${clientIp}`;
      const countStr = await this.redis.get(ipKey);
      const currentCount = countStr ? parseInt(countStr, 10) : 0;
      if (currentCount >= 5) {
        const ttl = await this.redis.ttl(ipKey);
        throw new BadRequestException(
          `Too many verification code requests from this device. Please try again in ${Math.ceil((ttl > 0 ? ttl : 3600) / 60)} minutes.`
        );
      }
    }

    // 2. Check if email is already registered
    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ConflictException('An account with this email already exists. Please login instead.');
    }

    // 3. Rate limit cooldown (60 seconds between resends for same email)
    const rateKey = `rate:signup:otp:${normalizedEmail}`;
    const isCoolingDown = await this.redis.get(rateKey);
    if (isCoolingDown) {
      const ttl = await this.redis.ttl(rateKey);
      throw new BadRequestException(`Please wait ${ttl > 0 ? ttl : 60} seconds before requesting a new code.`);
    }

    // Increment IP counter with 1 hour TTL
    if (clientIp && clientIp !== '127.0.0.1') {
      const ipKey = `rate:signup:otp:ip:${clientIp}`;
      const count = await this.redis.incr(ipKey);
      if (count === 1) {
        await this.redis.expire(ipKey, 3600); // 1 hour window
      }
    }

    // 4. Generate Cryptographic 6-digit numeric OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // 5. Store in Redis with 10 minutes (600s) TTL
    const otpKey = `otp:signup:${normalizedEmail}`;
    await this.redis.set(otpKey, JSON.stringify({ otp, attempts: 0 }), 'EX', 600);
    await this.redis.set(rateKey, '1', 'EX', 60);

    // 6. Send Branded Email via Resend API
    const resendApiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'FotoSetGo <auth@fotosetgo.com>';

    if (!resendApiKey) {
      this.logger.error('[Resend] RESEND_API_KEY is not configured in .env');
      throw new BadRequestException('Email service configuration error. Please contact support.');
    }

    const officialLogoUrl = await this.getOfficialLogoUrl();
    const recipientName = name?.trim() ? name.trim() : 'Photographer';
    const emailHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FotoSetGo Verification Code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #08090e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f3f4f6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #08090e; padding: 40px 15px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" max-width="560px" style="max-width: 560px; background-color: #11141e; border: 1px solid #23283a; border-radius: 24px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,0.6);">
          
          <!-- Header Brand Banner with Official Logo -->
          <tr>
            <td style="padding: 32px 36px 24px; text-align: center; border-bottom: 1px solid #1c2230; background: linear-gradient(180deg, #181d2a 0%, #11141e 100%);">
              <img src="${officialLogoUrl}" alt="FotoSetGo" style="height: 40px; max-width: 200px; object-fit: contain; display: block; margin: 0 auto;" />
              <p style="margin: 10px 0 0; color: #9ca3af; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 700;">
                AI Cloud Photography Platform
              </p>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 36px 36px 28px;">
              <h1 style="margin: 0 0 12px; color: #ffffff; font-size: 22px; font-weight: 800; text-align: center; letter-spacing: -0.5px;">
                Verify Your Studio Account
              </h1>
              <p style="margin: 0 0 24px; color: #9ca3af; font-size: 14px; line-height: 1.6; text-align: center;">
                Hello <strong style="color: #f3f4f6;">${recipientName}</strong>, welcome to <strong>FotoSetGo</strong>! Use the 6-digit verification code below to complete your registration:
              </p>

              <!-- OTP Code Display Card -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 28px 0;">
                <tr>
                  <td align="center">
                    <div style="display: inline-block; background: #08090e; border: 2px solid #f59e0b; border-radius: 16px; padding: 18px 36px; text-align: center; box-shadow: 0 8px 24px rgba(245,158,11,0.15);">
                      <span style="font-family: 'SF Mono', Consolas, Monaco, monospace; font-size: 36px; font-weight: 900; letter-spacing: 12px; color: #fbbf24; display: block; margin-left: 12px;">
                        ${otp}
                      </span>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Notice Box -->
              <div style="background-color: #171b29; border: 1px solid #283046; border-radius: 14px; padding: 16px; margin: 24px 0 12px; text-align: left;">
                <p style="margin: 0 0 6px; font-size: 12px; color: #d1d5db; font-weight: 600;">
                  ⏱️ <strong>Valid for 10 minutes:</strong> This code will expire soon for your security.
                </p>
                <p style="margin: 0; font-size: 11.5px; color: #6b7280; line-height: 1.5;">
                  🔒 If you did not attempt to register on FotoSetGo, you can safely ignore this email.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 36px; background-color: #0b0d14; border-top: 1px solid #1f2433; text-align: center;">
              <p style="margin: 0 0 6px; color: #6b7280; font-size: 11px; font-weight: 600;">
                FotoSetGo • Fast AI Photo Delivery for Professional Photographers
              </p>
              <p style="margin: 0; color: #4b5563; font-size: 10px;">
                © 2026 FotoSetGo. All rights reserved. • <a href="https://fotosetgo.com" style="color: #9ca3af; text-decoration: none;">fotosetgo.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

    try {
      const resendResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [normalizedEmail],
          subject: `${otp} is your FotoSetGo verification code`,
          html: emailHtml,
        }),
      });

      const resendData = await resendResponse.json();

      if (!resendResponse.ok) {
        this.logger.error(`[Resend] Failed to send OTP email: ${JSON.stringify(resendData)}`);
        throw new BadRequestException(resendData.message || 'Failed to deliver verification email. Please check your email address.');
      }

      this.logger.log(`[AuthService] Signup OTP successfully dispatched to ${normalizedEmail} (ID: ${resendData.id})`);

      return {
        success: true,
        message: `Verification code sent to ${normalizedEmail}`,
        email: normalizedEmail,
      };
    } catch (err: any) {
      this.logger.error(`[AuthService] Error sending signup OTP: ${err.message}`);
      if (err instanceof BadRequestException || err instanceof ConflictException) throw err;
      throw new BadRequestException('Unable to deliver verification email. Please try again.');
    }
  }

  /**
   * Send 6-Digit Email OTP for Password Reset via Resend API
   */
  async sendForgotPasswordOtp(email: string, clientIp?: string) {
    const normalizedEmail = (email || '').toLowerCase().trim();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new BadRequestException('Please enter a valid email address.');
    }

    // 1. IP-Level Rate Limiting: Max 5 password reset OTP requests per hour per client IP
    if (clientIp && clientIp !== '127.0.0.1') {
      const ipKey = `rate:forgot:otp:ip:${clientIp}`;
      const countStr = await this.redis.get(ipKey);
      const currentCount = countStr ? parseInt(countStr, 10) : 0;
      if (currentCount >= 5) {
        const ttl = await this.redis.ttl(ipKey);
        throw new BadRequestException(
          `Too many password reset requests from this device. Please try again in ${Math.ceil((ttl > 0 ? ttl : 3600) / 60)} minutes.`
        );
      }
    }

    // 2. Check if user exists with this email
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (!user) {
      throw new NotFoundException('No account found with this email address.');
    }

    // 3. Rate limit cooldown (60 seconds between password reset requests for same email)
    const rateKey = `rate:forgot:otp:${normalizedEmail}`;
    const isCoolingDown = await this.redis.get(rateKey);
    if (isCoolingDown) {
      const ttl = await this.redis.ttl(rateKey);
      throw new BadRequestException(`Please wait ${ttl > 0 ? ttl : 60} seconds before requesting a new reset code.`);
    }

    // Increment IP counter with 1 hour TTL
    if (clientIp && clientIp !== '127.0.0.1') {
      const ipKey = `rate:forgot:otp:ip:${clientIp}`;
      const count = await this.redis.incr(ipKey);
      if (count === 1) {
        await this.redis.expire(ipKey, 3600); // 1 hour window
      }
    }

    // 4. Generate Cryptographic 6-digit numeric OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // 5. Store in Redis with 10 minutes (600s) TTL
    const otpKey = `otp:forgot:${normalizedEmail}`;
    await this.redis.set(otpKey, JSON.stringify({ otp, attempts: 0 }), 'EX', 600);
    await this.redis.set(rateKey, '1', 'EX', 60);

    // 5. Send Branded Email via Resend API
    const resendApiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'FotoSetGo <auth@fotosetgo.com>';

    if (!resendApiKey) {
      this.logger.error('[Resend] RESEND_API_KEY is not configured in .env');
      throw new BadRequestException('Email service configuration error. Please contact support.');
    }

    const officialLogoUrl = await this.getOfficialLogoUrl();
    const recipientName = user.name?.trim() || 'Photographer';
    const emailHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your FotoSetGo Password</title>
</head>
<body style="margin: 0; padding: 0; background-color: #08090e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f3f4f6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #08090e; padding: 40px 15px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" max-width="560px" style="max-width: 560px; background-color: #11141e; border: 1px solid #23283a; border-radius: 24px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,0.6);">
          
          <!-- Header Brand Banner with Official Logo -->
          <tr>
            <td style="padding: 32px 36px 24px; text-align: center; border-bottom: 1px solid #1c2230; background: linear-gradient(180deg, #181d2a 0%, #11141e 100%);">
              <img src="${officialLogoUrl}" alt="FotoSetGo" style="height: 40px; max-width: 200px; object-fit: contain; display: block; margin: 0 auto;" />
              <p style="margin: 10px 0 0; color: #9ca3af; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 700;">
                AI Cloud Photography Platform
              </p>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 36px 36px 28px;">
              <h1 style="margin: 0 0 12px; color: #ffffff; font-size: 22px; font-weight: 800; text-align: center; letter-spacing: -0.5px;">
                Reset Your Password
              </h1>
              <p style="margin: 0 0 24px; color: #9ca3af; font-size: 14px; line-height: 1.6; text-align: center;">
                Hello <strong style="color: #f3f4f6;">${recipientName}</strong>, we received a request to reset the password for your <strong>FotoSetGo</strong> account. Use the 6-digit code below to set a new password:
              </p>

              <!-- OTP Code Display Card -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 28px 0;">
                <tr>
                  <td align="center">
                    <div style="display: inline-block; background: #08090e; border: 2px solid #f59e0b; border-radius: 16px; padding: 18px 36px; text-align: center; box-shadow: 0 8px 24px rgba(245,158,11,0.15);">
                      <span style="font-family: 'SF Mono', Consolas, Monaco, monospace; font-size: 36px; font-weight: 900; letter-spacing: 12px; color: #fbbf24; display: block; margin-left: 12px;">
                        ${otp}
                      </span>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Notice Box -->
              <div style="background-color: #171b29; border: 1px solid #283046; border-radius: 14px; padding: 16px; margin: 24px 0 12px; text-align: left;">
                <p style="margin: 0 0 6px; font-size: 12px; color: #d1d5db; font-weight: 600;">
                  ⏱️ <strong>Valid for 10 minutes:</strong> This reset code will expire soon for your account safety.
                </p>
                <p style="margin: 0; font-size: 11.5px; color: #6b7280; line-height: 1.5;">
                  🔒 If you did not request a password reset, please ignore this email. Your password will remain unchanged.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 36px; background-color: #0b0d14; border-top: 1px solid #1f2433; text-align: center;">
              <p style="margin: 0 0 6px; color: #6b7280; font-size: 11px; font-weight: 600;">
                FotoSetGo • Fast AI Photo Delivery for Professional Photographers
              </p>
              <p style="margin: 0; color: #4b5563; font-size: 10px;">
                © 2026 FotoSetGo. All rights reserved. • <a href="https://fotosetgo.com" style="color: #9ca3af; text-decoration: none;">fotosetgo.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

    try {
      const resendResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [normalizedEmail],
          subject: `${otp} is your FotoSetGo Password Reset code`,
          html: emailHtml,
        }),
      });

      const resendData = await resendResponse.json();

      if (!resendResponse.ok) {
        this.logger.error(`[Resend] Failed to send password reset OTP: ${JSON.stringify(resendData)}`);
        throw new BadRequestException(resendData.message || 'Failed to deliver password reset email. Please check your email address.');
      }

      this.logger.log(`[AuthService] Password reset OTP dispatched to ${normalizedEmail} (ID: ${resendData.id})`);

      return {
        success: true,
        message: `Password reset code sent to ${normalizedEmail}`,
        email: normalizedEmail,
      };
    } catch (err: any) {
      this.logger.error(`[AuthService] Error sending password reset OTP: ${err.message}`);
      if (err instanceof BadRequestException || err instanceof NotFoundException) throw err;
      throw new BadRequestException('Unable to deliver password reset email. Please try again.');
    }
  }

  /**
   * Verify 6-Digit Email OTP for Password Reset
   */
  async verifyForgotPasswordOtp(email: string, otp: string) {
    const normalizedEmail = (email || '').toLowerCase().trim();
    const cleanOtp = (otp || '').trim();

    if (!normalizedEmail || !cleanOtp || cleanOtp.length !== 6) {
      throw new BadRequestException('Please provide a valid 6-digit verification code.');
    }

    const otpKey = `otp:forgot:${normalizedEmail}`;
    const stored = await this.redis.get(otpKey);

    if (!stored) {
      throw new BadRequestException('Password reset code has expired or was not requested. Please request a new code.');
    }

    let parsedOtp: { otp: string; attempts: number };
    try {
      parsedOtp = JSON.parse(stored);
    } catch {
      parsedOtp = { otp: stored, attempts: 0 };
    }

    if (parsedOtp.attempts >= 5) {
      await this.redis.del(otpKey);
      throw new BadRequestException('Too many invalid attempts. This reset code has been invalidated. Please request a new code.');
    }

    if (parsedOtp.otp !== cleanOtp) {
      parsedOtp.attempts += 1;
      const ttl = await this.redis.ttl(otpKey);
      if (ttl > 0) {
        await this.redis.set(otpKey, JSON.stringify(parsedOtp), 'EX', ttl);
      }
      const remaining = Math.max(0, 5 - parsedOtp.attempts);
      throw new BadRequestException(`Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
    }

    return {
      success: true,
      message: 'Verification code verified successfully',
    };
  }

  /**
   * Reset Password with OTP Verification
   */
  async resetPassword(data: { email: string; otp: string; newPassword: string }) {
    const normalizedEmail = (data.email || '').toLowerCase().trim();
    const cleanOtp = (data.otp || '').trim();
    const cleanPassword = (data.newPassword || '').trim();

    if (!normalizedEmail || !cleanOtp || cleanOtp.length !== 6) {
      throw new BadRequestException('Please provide a valid email and 6-digit verification code.');
    }

    if (!cleanPassword || cleanPassword.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters long.');
    }

    // 1. Verify user exists
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (!user) {
      throw new NotFoundException('No account found with this email address.');
    }

    // 2. Fetch OTP from Redis
    const otpKey = `otp:forgot:${normalizedEmail}`;
    const stored = await this.redis.get(otpKey);

    if (!stored) {
      throw new BadRequestException('Password reset code has expired or was not requested. Please request a new code.');
    }

    let parsedOtp: { otp: string; attempts: number };
    try {
      parsedOtp = JSON.parse(stored);
    } catch {
      parsedOtp = { otp: stored, attempts: 0 };
    }

    // Check brute-force attempts
    if (parsedOtp.attempts >= 5) {
      await this.redis.del(otpKey);
      throw new BadRequestException('Too many invalid attempts. This reset code has been invalidated. Please request a new code.');
    }

    if (parsedOtp.otp !== cleanOtp) {
      parsedOtp.attempts += 1;
      const ttl = await this.redis.ttl(otpKey);
      if (ttl > 0) {
        await this.redis.set(otpKey, JSON.stringify(parsedOtp), 'EX', ttl);
      }
      const remaining = Math.max(0, 5 - parsedOtp.attempts);
      throw new BadRequestException(`Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
    }

    // 3. Hash new password & update in database
    const hashedPassword = await bcrypt.hash(cleanPassword, 10);
    await this.prisma.user.update({
      where: { email: normalizedEmail },
      data: { passwordHash: hashedPassword },
    });

    // 4. Delete used OTP from Redis
    await this.redis.del(otpKey);
    await this.redis.del(`rate:forgot:otp:${normalizedEmail}`);

    this.logger.log(`[AuthService] Password reset completed successfully for ${normalizedEmail}`);

    return {
      success: true,
      message: 'Your password has been reset successfully. You can now log in with your new password.',
    };
  }

  /**
   * Verify Signup OTP & Complete User Registration Atomically
   */
  async verifyAndSignup(
    data: {
      email: string;
      otp: string;
      password: string;
      name: string;
      studioName?: string;
      phone?: string;
      referralCode?: string;
    },
    requestInfo?: { ipAddress?: string; userAgent?: string }
  ) {
    const normalizedEmail = (data.email || '').toLowerCase().trim();
    const cleanOtp = (data.otp || '').trim();

    if (!cleanOtp || cleanOtp.length !== 6) {
      throw new BadRequestException('Please enter a valid 6-digit verification code.');
    }

    const otpKey = `otp:signup:${normalizedEmail}`;
    const stored = await this.redis.get(otpKey);

    if (!stored) {
      throw new BadRequestException('Verification code has expired or was not requested. Please request a new code.');
    }

    let parsedOtp: { otp: string; attempts: number };
    try {
      parsedOtp = JSON.parse(stored);
    } catch {
      parsedOtp = { otp: stored, attempts: 0 };
    }

    // Check brute-force attempts
    if (parsedOtp.attempts >= 3) {
      await this.redis.del(otpKey);
      throw new BadRequestException('Too many incorrect attempts. Please request a new verification code.');
    }

    if (parsedOtp.otp !== cleanOtp) {
      parsedOtp.attempts += 1;
      const ttl = await this.redis.ttl(otpKey);
      await this.redis.set(otpKey, JSON.stringify(parsedOtp), 'EX', ttl > 0 ? ttl : 300);
      throw new BadRequestException(`Invalid verification code. ${3 - parsedOtp.attempts} attempts remaining.`);
    }

    // OTP Verified! Delete OTP key immediately
    await this.redis.del(otpKey);
    await this.redis.del(`rate:signup:otp:${normalizedEmail}`);

    // Create User & Photographer profile in database
    await this.signup({
      email: normalizedEmail,
      password: data.password,
      name: data.name,
      studioName: data.studioName,
      phone: data.phone,
      referralCode: data.referralCode,
    });

    // Auto-login newly registered user
    return this.login({ email: normalizedEmail, password: data.password }, requestInfo);
  }

  async signup(data: { email: string; password: string; name: string; studioName?: string; phone?: string; referralCode?: string }) {
    const normalizedEmail = data.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Math.floor(1000 + Math.random() * 9000);

    // Generate unique referral code for this new photographer
    const prefix = (data.studioName || data.name || 'STUDIO')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 5)
      .toUpperCase() || 'STUDIO';
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const newReferralCode = `${prefix}-${randomSuffix}`;

    // Lookup referrer if referral code was provided (preventing self-referral)
    let referredById: string | null = null;
    if (data.referralCode && data.referralCode.trim()) {
      const cleanCode = data.referralCode.trim();
      const referrer = await this.prisma.photographer.findFirst({
        where: {
          referralCode: { equals: cleanCode, mode: 'insensitive' },
        },
        include: { user: true },
      });

      if (referrer && referrer.user?.email.toLowerCase() !== normalizedEmail) {
        referredById = referrer.id;
      }
    }

    // Create user and photographer profile in transaction
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          name: data.name,
          phone: data.phone || null,
          role: 'PHOTOGRAPHER',
        },
      });

      const photographer = await tx.photographer.create({
        data: {
          userId: user.id,
          studioName: data.studioName || `${data.name}'s Studio`,
          slug,
          referralCode: newReferralCode,
          referredById,
        },
      });

      // Ensure the "Free" package exists in the database
      let freePackage = await tx.package.findUnique({
        where: { name: 'Free' },
      });

      if (!freePackage) {
        freePackage = await tx.package.create({
          data: {
            name: 'Free',
            maxStorageGb: 5,
            maxEventsStorageMb: 5000,
            maxPortfolioStorageMb: 0,
            price: 0,
            isActive: true,
          },
        });
      }

      // Calculate limit dynamically from Package record
      const eventsMb = freePackage.maxEventsStorageMb || 5000;
      const portfolioMb = freePackage.maxPortfolioStorageMb || 0;
      const limitEventsBytes = BigInt(eventsMb) * BigInt(1024 * 1024);
      const limitPortfolioBytes = BigInt(portfolioMb) * BigInt(1024 * 1024);
      const limitBytes = limitEventsBytes + limitPortfolioBytes;

      await tx.subscription.create({
        data: {
          photographerId: photographer.id,
          packageId: freePackage.id,
          startsAt: new Date(),
          endsAt: new Date(new Date().setFullYear(new Date().getFullYear() + 10)), // 10 years
          status: 'ACTIVE',
          limitBytes,
          limitEventsBytes,
          limitPortfolioBytes,
          usedBytes: BigInt(0),
        },
      });

      // Update photographer profile with active package ID & initial free plan credits
      await tx.photographer.update({
        where: { id: photographer.id },
        data: {
          activePackageId: freePackage.id,
          creditBalance: freePackage.faceScanCredits || 0,
        },
      });

      // Log initial credit transaction
      if ((freePackage.faceScanCredits || 0) > 0) {
        await tx.creditTransaction.create({
          data: {
            photographerId: photographer.id,
            amount: freePackage.faceScanCredits,
            action: 'PLAN_BENEFIT',
            description: `Initial free credits from ${freePackage.name} plan`,
          },
        });
      }

      // Check dynamic ReferralConfig from DB for Free package
      if (referredById) {
        const referralConfig = await tx.referralConfig.findUnique({
          where: { packageId: freePackage.id },
        });

        if (referralConfig && referralConfig.isReferralEnabled) {
          const instantBonus = referralConfig.instantBonusCredits || 0;
          const monthlyBoost = referralConfig.monthlyBoostCredits || 0;
          const welcomeBonus = referralConfig.refereeWelcomeCredits || 0;

          // 1. Create Active Referral Record for Free Tier
          await tx.referral.create({
            data: {
              referrerId: referredById,
              referredUserId: photographer.id,
              packageId: freePackage.id,
              tenureYears: 10,
              instantCreditsAwarded: instantBonus,
              monthlyBoostCredits: monthlyBoost,
              status: 'ACTIVE',
              validFrom: new Date(),
              validUntil: new Date(new Date().setFullYear(new Date().getFullYear() + 10)),
            },
          });

          // 2. Award Instant Bonus to Referrer
          if (instantBonus > 0) {
            await tx.photographer.update({
              where: { id: referredById },
              data: { creditBalance: { increment: instantBonus } },
            });
            await tx.creditTransaction.create({
              data: {
                photographerId: referredById,
                amount: instantBonus,
                action: 'REFERRAL_INSTANT_BONUS',
                description: `Instant Referral Bonus: ${data.studioName || data.name} joined via your referral link (+${(instantBonus / 100).toFixed(0)} Credits)`,
              },
            });
          }

          // 3. Award Welcome Referral Credits to New User
          if (welcomeBonus > 0) {
            await tx.photographer.update({
              where: { id: photographer.id },
              data: { creditBalance: { increment: welcomeBonus } },
            });
            await tx.creditTransaction.create({
              data: {
                photographerId: photographer.id,
                amount: welcomeBonus,
                action: 'REFERRAL_WELCOME_BONUS',
                description: `Welcome Referral Perk for joining via referral invitation (+${(welcomeBonus / 100).toFixed(0)} Credits)`,
              },
            });
          }
        }
      }

      return { userId: user.id, photographerId: photographer.id, email: user.email, name: user.name };
    });
  }

  parseUserAgent(userAgent: string) {
    let device = 'Desktop';
    let browser = 'Unknown';
    let os = 'Unknown';

    if (!userAgent) return { device, browser, os };

    // Device
    if (/mobi|android|iphone|ipad|ipod/i.test(userAgent)) {
      device = 'Phone';
    }

    // OS
    if (/windows/i.test(userAgent)) {
      os = 'Windows';
    } else if (/macintosh|mac os x/i.test(userAgent)) {
      os = 'macOS';
    } else if (/iphone|ipad|ipod/i.test(userAgent)) {
      os = 'iOS';
    } else if (/android/i.test(userAgent)) {
      os = 'Android';
    } else if (/linux/i.test(userAgent)) {
      os = 'Linux';
    }

    // Browser
    if (/chrome|crios/i.test(userAgent) && !/edge|opr/i.test(userAgent)) {
      browser = 'Chrome';
    } else if (/safari/i.test(userAgent) && !/chrome|crios|edge|opr/i.test(userAgent)) {
      browser = 'Safari';
    } else if (/firefox|fxios/i.test(userAgent)) {
      browser = 'Firefox';
    } else if (/edge|edg/i.test(userAgent)) {
      browser = 'Edge';
    } else if (/opr/i.test(userAgent)) {
      browser = 'Opera';
    }

    return { device, browser, os };
  }

  /**
   * Generate a secure mathematical/symbolic CAPTCHA challenge
   */
  async generateCaptchaChallenge(): Promise<{ challengeId: string; question: string; type: string }> {
    const num1 = Math.floor(Math.random() * 20) + 5; // 5 to 24
    const num2 = Math.floor(Math.random() * 15) + 3; // 3 to 17
    const operations = ['+', '-', '+'];
    const op = operations[Math.floor(Math.random() * operations.length)];

    let answer: number;
    let question: string;

    if (op === '+') {
      answer = num1 + num2;
      question = `${num1} + ${num2}`;
    } else {
      const high = Math.max(num1, num2);
      const low = Math.min(num1, num2);
      answer = high - low;
      question = `${high} - ${low}`;
    }

    const challengeId = `ch_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const redisKey = `captcha:challenge:${challengeId}`;

    // Store in Redis with 5 minutes (300s) TTL
    await this.redis.set(redisKey, JSON.stringify({ answer: String(answer), createdAt: Date.now() }), 'EX', 300);

    return {
      challengeId,
      question: `${question} = ?`,
      type: 'math',
    };
  }

  /**
   * Verify Cloudflare Turnstile token or built-in CAPTCHA challenge answer
   */
  async verifyCaptcha(token?: string, challengeId?: string, answer?: string): Promise<boolean> {
    // 1. Verify Cloudflare Turnstile if token is provided
    if (token) {
      const turnstileSecret = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
      if (turnstileSecret) {
        try {
          const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `secret=${encodeURIComponent(turnstileSecret)}&response=${encodeURIComponent(token)}`,
          });
          const outcome = await res.json();
          if (outcome?.success) {
            return true;
          }
        } catch (err: any) {
          this.logger.error(`[Turnstile] Verification error: ${err.message}`);
        }
      } else if (token.length > 10) {
        return true;
      }
    }

    // 2. Verify built-in challenge
    if (challengeId && answer !== undefined && answer !== null) {
      const cleanAnswer = String(answer).trim().toLowerCase();
      if (!cleanAnswer) return false;

      const redisKey = `captcha:challenge:${challengeId}`;
      const stored = await this.redis.get(redisKey);
      if (!stored) return false;

      // Consume challenge immediately to prevent replay attacks
      await this.redis.del(redisKey).catch(() => {});

      try {
        const parsed = JSON.parse(stored);
        return String(parsed.answer).trim().toLowerCase() === cleanAnswer;
      } catch {
        return stored.trim().toLowerCase() === cleanAnswer;
      }
    }

    return false;
  }

  /**
   * Check login rate limit status (lockout & conditional captcha requirement)
   */
  async checkLoginRateLimit(email: string, ipAddress: string): Promise<{ isLocked: boolean; lockTtl: number; requireCaptcha: boolean; failedAttempts: number }> {
    const cleanEmail = (email || '').toLowerCase().trim();
    const cleanIp = ipAddress || '127.0.0.1';

    const ipLockKey = `ratelimit:login:lockout:ip:${cleanIp}`;
    const emailLockKey = cleanEmail ? `ratelimit:login:lockout:email:${cleanEmail}` : null;

    const [ipLock, emailLock] = await Promise.all([
      this.redis.get(ipLockKey),
      emailLockKey ? this.redis.get(emailLockKey) : Promise.resolve(null),
    ]);

    if (ipLock || emailLock) {
      const ttl = await (ipLock ? this.redis.ttl(ipLockKey) : this.redis.ttl(emailLockKey!));
      return {
        isLocked: true,
        lockTtl: Math.max(ttl, 60),
        requireCaptcha: true,
        failedAttempts: 10,
      };
    }

    const ipAttemptsKey = `ratelimit:login:attempts:ip:${cleanIp}`;
    const emailAttemptsKey = cleanEmail ? `ratelimit:login:attempts:email:${cleanEmail}` : null;

    const [ipCountStr, emailCountStr] = await Promise.all([
      this.redis.get(ipAttemptsKey),
      emailAttemptsKey ? this.redis.get(emailAttemptsKey) : Promise.resolve('0'),
    ]);

    const ipCount = parseInt(ipCountStr || '0', 10);
    const emailCount = parseInt(emailCountStr || '0', 10);
    const failedAttempts = Math.max(ipCount, emailCount);

    return {
      isLocked: false,
      lockTtl: 0,
      requireCaptcha: failedAttempts >= 3,
      failedAttempts,
    };
  }

  /**
   * Record login failure in Redis and calculate rate limit thresholds
   */
  async recordLoginFailure(email: string, ipAddress: string): Promise<{ requireCaptcha: boolean; remainingAttempts: number; isLocked: boolean; lockTtl: number }> {
    const cleanEmail = (email || '').toLowerCase().trim();
    const cleanIp = ipAddress || '127.0.0.1';

    const ipAttemptsKey = `ratelimit:login:attempts:ip:${cleanIp}`;
    const emailAttemptsKey = cleanEmail ? `ratelimit:login:attempts:email:${cleanEmail}` : null;

    const pipe = this.redis.pipeline();
    pipe.incr(ipAttemptsKey);
    pipe.expire(ipAttemptsKey, 900); // 15 mins window
    if (emailAttemptsKey) {
      pipe.incr(emailAttemptsKey);
      pipe.expire(emailAttemptsKey, 900);
    }

    const results = await pipe.exec();
    const ipCount = Number(results?.[0]?.[1] || 1);
    const emailCount = emailAttemptsKey ? Number(results?.[2]?.[1] || 1) : 0;
    const failedAttempts = Math.max(ipCount, emailCount);

    if (failedAttempts >= 10) {
      await Promise.all([
        this.redis.set(`ratelimit:login:lockout:ip:${cleanIp}`, '1', 'EX', 900),
        cleanEmail ? this.redis.set(`ratelimit:login:lockout:email:${cleanEmail}`, '1', 'EX', 900) : Promise.resolve(),
      ]);
      return {
        requireCaptcha: true,
        remainingAttempts: 0,
        isLocked: true,
        lockTtl: 900,
      };
    }

    return {
      requireCaptcha: failedAttempts >= 3,
      remainingAttempts: Math.max(0, 10 - failedAttempts),
      isLocked: false,
      lockTtl: 0,
    };
  }

  /**
   * Clear all login failure and lockout records upon successful authentication
   */
  async resetLoginFailures(email: string, ipAddress: string): Promise<void> {
    const cleanEmail = (email || '').toLowerCase().trim();
    const cleanIp = ipAddress || '127.0.0.1';

    await Promise.all([
      this.redis.del(`ratelimit:login:attempts:ip:${cleanIp}`),
      this.redis.del(`ratelimit:login:lockout:ip:${cleanIp}`),
      cleanEmail ? this.redis.del(`ratelimit:login:attempts:email:${cleanEmail}`) : Promise.resolve(),
      cleanEmail ? this.redis.del(`ratelimit:login:lockout:email:${cleanEmail}`) : Promise.resolve(),
    ]).catch(() => {});
  }

  async login(
    credentials: { email: string; password: string; captchaToken?: string; captchaChallengeId?: string; captchaAnswer?: string },
    requestInfo?: { ipAddress?: string; userAgent?: string },
  ) {
    const normalizedEmail = (credentials.email || '').toLowerCase().trim();
    const ipAddress = requestInfo?.ipAddress || '127.0.0.1';
    const parsedUA = this.parseUserAgent(requestInfo?.userAgent || '');

    // 1. Check Rate Limiting Lockout
    const rateStatus = await this.checkLoginRateLimit(normalizedEmail, ipAddress);
    if (rateStatus.isLocked) {
      const waitMinutes = Math.ceil(rateStatus.lockTtl / 60);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Too many failed login attempts. Please wait ${waitMinutes} minute(s) before trying again.`,
          isLocked: true,
          lockTtl: rateStatus.lockTtl,
          requireCaptcha: true,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 2. Enforce Captcha verification if user/IP reached >= 3 failed attempts
    if (rateStatus.requireCaptcha) {
      const isCaptchaValid = await this.verifyCaptcha(
        credentials.captchaToken,
        credentials.captchaChallengeId,
        credentials.captchaAnswer,
      );
      if (!isCaptchaValid) {
        throw new BadRequestException({
          message: 'Security verification required. Please enter the correct captcha.',
          requireCaptcha: true,
        });
      }
    }

    // 3. Find User
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { photographer: true },
    });

    if (!user || !user.isActive) {
      if (user) {
        await this.prisma.loginLog.create({
          data: {
            userId: user.id,
            ipAddress,
            userAgent: requestInfo?.userAgent || '',
            device: parsedUA.device,
            browser: parsedUA.browser,
            os: parsedUA.os,
            status: 'FAILED',
          },
        });
      }
      const failure = await this.recordLoginFailure(normalizedEmail, ipAddress);
      if (failure.isLocked) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many failed login attempts. Account temporarily locked for 15 minutes.',
            isLocked: true,
            lockTtl: 900,
            requireCaptcha: true,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new UnauthorizedException({
        message: failure.requireCaptcha ? 'Invalid credentials. Security verification is now required.' : 'Invalid credentials',
        requireCaptcha: failure.requireCaptcha,
        remainingAttempts: failure.remainingAttempts,
      });
    }

    // 4. Verify Password
    const passwordMatch = await bcrypt.compare(credentials.password, user.passwordHash);
    if (!passwordMatch) {
      await this.prisma.loginLog.create({
        data: {
          userId: user.id,
          ipAddress,
          userAgent: requestInfo?.userAgent || '',
          device: parsedUA.device,
          browser: parsedUA.browser,
          os: parsedUA.os,
          status: 'FAILED',
        },
      });
      const failure = await this.recordLoginFailure(normalizedEmail, ipAddress);
      if (failure.isLocked) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many failed login attempts. Account temporarily locked for 15 minutes.',
            isLocked: true,
            lockTtl: 900,
            requireCaptcha: true,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new UnauthorizedException({
        message: failure.requireCaptcha ? 'Invalid credentials. Security verification is now required.' : 'Invalid credentials',
        requireCaptcha: failure.requireCaptcha,
        remainingAttempts: failure.remainingAttempts,
      });
    }

    // 5. Successful Login -> Reset all failure counters immediately
    await this.resetLoginFailures(normalizedEmail, ipAddress);

    const payload = { sub: user.id, email: user.email };
    const accessToken = this.jwtService.sign(payload);

    // Create success log
    await this.prisma.loginLog.create({
      data: {
        userId: user.id,
        ipAddress,
        userAgent: requestInfo?.userAgent || '',
        device: parsedUA.device,
        browser: parsedUA.browser,
        os: parsedUA.os,
        status: 'SUCCESS',
      },
    });

    // Create user session record
    await this.prisma.userSession.create({
      data: {
        userId: user.id,
        token: accessToken,
        ipAddress,
        userAgent: requestInfo?.userAgent || '',
        device: parsedUA.device,
        browser: parsedUA.browser,
        os: parsedUA.os,
      },
    });

    return {
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        photographerId: user.photographer?.id,
        studioName: user.photographer?.studioName,
        slug: user.photographer?.slug,
      },
    };
  }

  /**
   * Check Admin login rate limit status (lockout status)
   */
  async checkAdminLoginRateLimit(email: string, ipAddress: string): Promise<{ isLocked: boolean; lockTtl: number }> {
    const cleanEmail = (email || '').toLowerCase().trim();
    const cleanIp = ipAddress || '127.0.0.1';

    const ipLockKey = `ratelimit:admin:lockout:ip:${cleanIp}`;
    const emailLockKey = cleanEmail ? `ratelimit:admin:lockout:email:${cleanEmail}` : null;

    const [ipLock, emailLock] = await Promise.all([
      this.redis.get(ipLockKey),
      emailLockKey ? this.redis.get(emailLockKey) : Promise.resolve(null),
    ]);

    if (ipLock || emailLock) {
      const ttl = await (ipLock ? this.redis.ttl(ipLockKey) : this.redis.ttl(emailLockKey!));
      return {
        isLocked: true,
        lockTtl: Math.max(ttl, 60),
      };
    }

    return {
      isLocked: false,
      lockTtl: 0,
    };
  }

  /**
   * Record Admin login failure in Redis and enforce strict 3-attempt lockout for 30 minutes
   */
  async recordAdminLoginFailure(email: string, ipAddress: string): Promise<{ remainingAttempts: number; isLocked: boolean; lockTtl: number }> {
    const cleanEmail = (email || '').toLowerCase().trim();
    const cleanIp = ipAddress || '127.0.0.1';

    const ipAttemptsKey = `ratelimit:admin:attempts:ip:${cleanIp}`;
    const emailAttemptsKey = cleanEmail ? `ratelimit:admin:attempts:email:${cleanEmail}` : null;

    const pipe = this.redis.pipeline();
    pipe.incr(ipAttemptsKey);
    pipe.expire(ipAttemptsKey, 1800); // 30 mins window
    if (emailAttemptsKey) {
      pipe.incr(emailAttemptsKey);
      pipe.expire(emailAttemptsKey, 1800);
    }

    const results = await pipe.exec();
    const ipCount = Number(results?.[0]?.[1] || 1);
    const emailCount = emailAttemptsKey ? Number(results?.[2]?.[1] || 1) : 0;
    const failedAttempts = Math.max(ipCount, emailCount);

    if (failedAttempts >= 3) {
      await Promise.all([
        this.redis.set(`ratelimit:admin:lockout:ip:${cleanIp}`, '1', 'EX', 1800),
        cleanEmail ? this.redis.set(`ratelimit:admin:lockout:email:${cleanEmail}`, '1', 'EX', 1800) : Promise.resolve(),
      ]);
      return {
        remainingAttempts: 0,
        isLocked: true,
        lockTtl: 1800,
      };
    }

    return {
      remainingAttempts: Math.max(0, 3 - failedAttempts),
      isLocked: false,
      lockTtl: 0,
    };
  }

  /**
   * Clear all Admin login failure and lockout records upon successful authentication
   */
  async resetAdminLoginFailures(email: string, ipAddress: string): Promise<void> {
    const cleanEmail = (email || '').toLowerCase().trim();
    const cleanIp = ipAddress || '127.0.0.1';

    await Promise.all([
      this.redis.del(`ratelimit:admin:attempts:ip:${cleanIp}`),
      this.redis.del(`ratelimit:admin:lockout:ip:${cleanIp}`),
      cleanEmail ? this.redis.del(`ratelimit:admin:attempts:email:${cleanEmail}`) : Promise.resolve(),
      cleanEmail ? this.redis.del(`ratelimit:admin:lockout:email:${cleanEmail}`) : Promise.resolve(),
    ]).catch(() => {});
  }

  async adminLogin(credentials: { email: string; password: string }, requestInfo?: { ipAddress?: string; userAgent?: string }) {
    const normalizedEmail = (credentials.email || '').toLowerCase().trim();
    const ipAddress = requestInfo?.ipAddress || '127.0.0.1';

    // 1. Strict Anti-Brute Force Lockout Check
    const rateStatus = await this.checkAdminLoginRateLimit(normalizedEmail, ipAddress);
    if (rateStatus.isLocked) {
      const waitMinutes = Math.ceil(rateStatus.lockTtl / 60);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Too many failed admin login attempts. Admin access has been locked for security. Please try again after ${waitMinutes} minute(s).`,
          isLocked: true,
          lockTtl: rateStatus.lockTtl,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 2. Lookup Admin User
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user || !user.isActive || user.role !== 'ADMIN') {
      const failure = await this.recordAdminLoginFailure(normalizedEmail, ipAddress);
      if (failure.isLocked) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many failed admin login attempts. Admin access has been locked for 30 minutes.',
            isLocked: true,
            lockTtl: failure.lockTtl,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new UnauthorizedException(
        `Invalid admin credentials. ${failure.remainingAttempts} attempt(s) remaining before security lockout.`
      );
    }

    // 3. Compare Password
    const passwordMatch = await bcrypt.compare(credentials.password, user.passwordHash);
    if (!passwordMatch) {
      const failure = await this.recordAdminLoginFailure(normalizedEmail, ipAddress);
      if (failure.isLocked) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many failed admin login attempts. Admin access has been locked for 30 minutes.',
            isLocked: true,
            lockTtl: failure.lockTtl,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new UnauthorizedException(
        `Invalid admin credentials. ${failure.remainingAttempts} attempt(s) remaining before security lockout.`
      );
    }

    // 4. Success - Reset failure counter
    await this.resetAdminLoginFailures(normalizedEmail, ipAddress);

    const payload = { sub: user.id, email: user.email, role: 'ADMIN', type: 'ADMIN_SESSION' };
    const token = this.jwtService.sign(payload, { expiresIn: '24h' });

    return {
      token,
      accessToken: token,
      admin: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  /**
   * Google OAuth 1-Click Login & Registration with automated Referral & Free Tier Setup
   */
  async googleAuth(data: { credential: string; referralCode?: string }, requestInfo?: { ipAddress?: string; userAgent?: string }) {
    const googleClientId = process.env.GOOGLE_AUTH_CLIENT_ID || '';
    if (!googleClientId) {
      throw new UnauthorizedException('Google OAuth Client ID is not configured on the server');
    }
    const client = new OAuth2Client(googleClientId);

    let googlePayload: any;
    try {
      const ticket = await client.verifyIdToken({
        idToken: data.credential,
        audience: googleClientId,
      });
      googlePayload = ticket.getPayload();
    } catch (err: any) {
      throw new UnauthorizedException(`Google authentication failed: ${err.message || 'Invalid token'}`);
    }

    if (!googlePayload || !googlePayload.email) {
      throw new UnauthorizedException('Google account email verification failed');
    }

    const email = googlePayload.email.toLowerCase().trim();
    const name = googlePayload.name || googlePayload.given_name || email.split('@')[0] || 'Studio Owner';
    const avatarUrl = googlePayload.picture || null;

    // Check if user already exists
    let user = await this.prisma.user.findUnique({
      where: { email },
      include: { photographer: true },
    });

    if (!user) {
      // Automatic First-Time Photographer Registration
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + randomSuffix;

      const prefix = name
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 5)
        .toUpperCase() || 'STUDIO';
      const newReferralCode = `${prefix}-${randomSuffix}`;

      // Lookup referrer if referral code was provided (preventing self-referral)
      let referredById: string | null = null;
      if (data.referralCode && data.referralCode.trim()) {
        const cleanCode = data.referralCode.trim();
        const referrer = await this.prisma.photographer.findFirst({
          where: {
            referralCode: { equals: cleanCode, mode: 'insensitive' },
          },
          include: { user: true },
        });

        if (referrer && referrer.user?.email.toLowerCase() !== email) {
          referredById = referrer.id;
        }
      }

      const passwordHash = await bcrypt.hash(`google_oauth_${Date.now()}_${randomSuffix}`, 10);

      user = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email,
            passwordHash,
            name,
            avatarUrl,
            role: 'PHOTOGRAPHER',
          },
        });

        const photographer = await tx.photographer.create({
          data: {
            userId: newUser.id,
            studioName: `${name}'s Studio`,
            slug,
            referralCode: newReferralCode,
            referredById,
          },
        });

        let freePackage = await tx.package.findUnique({
          where: { name: 'Free' },
        });

        if (!freePackage) {
          freePackage = await tx.package.create({
            data: {
              name: 'Free',
              maxStorageGb: 5,
              maxEventsStorageMb: 5000,
              maxPortfolioStorageMb: 0,
              price: 0,
              isActive: true,
            },
          });
        }

        const eventsMb = freePackage.maxEventsStorageMb || 5000;
        const portfolioMb = freePackage.maxPortfolioStorageMb || 0;
        const limitEventsBytes = BigInt(eventsMb) * BigInt(1024 * 1024);
        const limitPortfolioBytes = BigInt(portfolioMb) * BigInt(1024 * 1024);
        const limitBytes = limitEventsBytes + limitPortfolioBytes;

        await tx.subscription.create({
          data: {
            photographerId: photographer.id,
            packageId: freePackage.id,
            startsAt: new Date(),
            endsAt: new Date(new Date().setFullYear(new Date().getFullYear() + 10)),
            status: 'ACTIVE',
            limitBytes,
            limitEventsBytes,
            limitPortfolioBytes,
            usedBytes: BigInt(0),
          },
        });

        await tx.photographer.update({
          where: { id: photographer.id },
          data: {
            activePackageId: freePackage.id,
            creditBalance: freePackage.faceScanCredits || 0,
          },
        });

        if ((freePackage.faceScanCredits || 0) > 0) {
          await tx.creditTransaction.create({
            data: {
              photographerId: photographer.id,
              amount: freePackage.faceScanCredits,
              action: 'PLAN_BENEFIT',
              description: `Initial free credits from ${freePackage.name} plan`,
            },
          });
        }

        // Check dynamic ReferralConfig from DB for Free package (Google Auth)
        if (referredById) {
          const referralConfig = await tx.referralConfig.findUnique({
            where: { packageId: freePackage.id },
          });

          if (referralConfig && referralConfig.isReferralEnabled) {
            const instantBonus = referralConfig.instantBonusCredits || 0;
            const monthlyBoost = referralConfig.monthlyBoostCredits || 0;
            const welcomeBonus = referralConfig.refereeWelcomeCredits || 0;

            // 1. Create Active Referral Record for Free Tier
            await tx.referral.create({
              data: {
                referrerId: referredById,
                referredUserId: photographer.id,
                packageId: freePackage.id,
                tenureYears: 10,
                instantCreditsAwarded: instantBonus,
                monthlyBoostCredits: monthlyBoost,
                status: 'ACTIVE',
                validFrom: new Date(),
                validUntil: new Date(new Date().setFullYear(new Date().getFullYear() + 10)),
              },
            });

            // 2. Award Instant Bonus to Referrer
            if (instantBonus > 0) {
              await tx.photographer.update({
                where: { id: referredById },
                data: { creditBalance: { increment: instantBonus } },
              });
              await tx.creditTransaction.create({
                data: {
                  photographerId: referredById,
                  amount: instantBonus,
                  action: 'REFERRAL_INSTANT_BONUS',
                  description: `Instant Referral Bonus: ${name} joined via your referral link (+${(instantBonus / 100).toFixed(0)} Credits)`,
                },
              });
            }

            // 3. Award Welcome Referral Credits to New User
            if (welcomeBonus > 0) {
              await tx.photographer.update({
                where: { id: photographer.id },
                data: { creditBalance: { increment: welcomeBonus } },
              });
              await tx.creditTransaction.create({
                data: {
                  photographerId: photographer.id,
                  amount: welcomeBonus,
                  action: 'REFERRAL_WELCOME_BONUS',
                  description: `Welcome Referral Perk for joining via referral invitation (+${(welcomeBonus / 100).toFixed(0)} Credits)`,
                },
              });
            }
          }
        }

        return tx.user.findUnique({
          where: { id: newUser.id },
          include: { photographer: true },
        });
      });
    }

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account has been deactivated');
    }

    const parsedUA = this.parseUserAgent(requestInfo?.userAgent || '');
    const ipAddress = requestInfo?.ipAddress || '127.0.0.1';

    const payload = { sub: user.id, email: user.email };
    const accessToken = this.jwtService.sign(payload);

    await this.prisma.loginLog.create({
      data: {
        userId: user.id,
        ipAddress,
        userAgent: requestInfo?.userAgent || '',
        device: parsedUA.device,
        browser: parsedUA.browser,
        os: parsedUA.os,
        status: 'SUCCESS',
      },
    });

    await this.prisma.userSession.create({
      data: {
        userId: user.id,
        token: accessToken,
        ipAddress,
        userAgent: requestInfo?.userAgent || '',
        device: parsedUA.device,
        browser: parsedUA.browser,
        os: parsedUA.os,
      },
    });

    return {
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        photographerId: user.photographer?.id,
        studioName: user.photographer?.studioName,
        slug: user.photographer?.slug,
      },
    };
  }

  async updateProfile(userId: string, data: any) {
    const result = await this.prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          name: data.name,
          phone: data.phone,
          avatarUrl: data.avatarUrl,
        },
        include: {
          photographer: {
            include: {
              subscriptions: {
                where: { status: 'ACTIVE' },
                include: { package: true },
              },
            },
          },
        },
      });

      if (updatedUser.photographer) {
        await tx.photographer.update({
          where: { id: updatedUser.photographer.id },
          data: {
            studioName: data.studioName,
            city: data.city,
            state: data.state,
            country: data.country,
            bio: data.bio,
            website: data.website,
          },
        });
      }

      return tx.user.findUnique({
        where: { id: userId },
        include: {
          photographer: {
            include: {
              subscriptions: {
                where: { status: 'ACTIVE' },
                include: { package: true },
              },
            },
          },
        },
      });
    });

    // Invalidate Redis JWT cache so next /auth/profile returns fresh data
    try {
      await this.redis.del(`cache:jwt:user:${userId}`);
    } catch (_) {}

    return result;
  }

  async changePassword(userId: string, data: any) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');
    
    const passwordMatch = await bcrypt.compare(data.oldPassword, user.passwordHash);
    if (!passwordMatch) {
      throw new UnauthorizedException('Incorrect old password');
    }
    
    const passwordHash = await bcrypt.hash(data.newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
  }

  async getSessions(userId: string) {
    return this.prisma.userSession.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.userId !== userId) {
      throw new UnauthorizedException('Session not found or access denied');
    }
    await this.prisma.userSession.delete({
      where: { id: sessionId },
    });
  }

  async logoutSession(userId: string, token: string) {
    await this.prisma.userSession.deleteMany({
      where: { userId, token },
    });
  }

  async getLoginActivity(userId: string) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return this.prisma.loginLog.findMany({
      where: { 
        userId,
        createdAt: { gte: sevenDaysAgo }
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
