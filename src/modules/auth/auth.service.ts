import { Injectable, ConflictException, UnauthorizedException, BadRequestException, Inject, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { OAuth2Client } from 'google-auth-library';
import Redis from 'ioredis';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    @Inject('REDIS_CLIENT') private redis: Redis,
  ) {}

  /**
   * Send 6-Digit Email OTP for Studio Registration via Resend API
   */
  async sendSignupOtp(email: string, name?: string) {
    const normalizedEmail = (email || '').toLowerCase().trim();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new BadRequestException('Please enter a valid email address.');
    }

    // 1. Check if email is already registered
    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ConflictException('An account with this email already exists. Please login instead.');
    }

    // 2. Rate limit cooldown (60 seconds between resends)
    const rateKey = `rate:signup:otp:${normalizedEmail}`;
    const isCoolingDown = await this.redis.get(rateKey);
    if (isCoolingDown) {
      const ttl = await this.redis.ttl(rateKey);
      throw new BadRequestException(`Please wait ${ttl > 0 ? ttl : 60} seconds before requesting a new code.`);
    }

    // 3. Generate Cryptographic 6-digit numeric OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // 4. Store in Redis with 10 minutes (600s) TTL
    const otpKey = `otp:signup:${normalizedEmail}`;
    await this.redis.set(otpKey, JSON.stringify({ otp, attempts: 0 }), 'EX', 600);
    await this.redis.set(rateKey, '1', 'EX', 60);

    // 5. Send Branded Email via Resend API
    const resendApiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'FotoSetGo <auth@fotosetgo.com>';

    if (!resendApiKey) {
      this.logger.error('[Resend] RESEND_API_KEY is not configured in .env');
      throw new BadRequestException('Email service configuration error. Please contact support.');
    }

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
          
          <!-- Header Brand Banner -->
          <tr>
            <td style="padding: 32px 36px 24px; text-align: center; border-bottom: 1px solid #1c2230; background: linear-gradient(180deg, #181d2a 0%, #11141e 100%);">
              <div style="display: inline-flex; align-items: center; justify-content: center; gap: 10px;">
                <span style="font-size: 26px; line-height: 1;">📸</span>
                <span style="font-size: 24px; font-weight: 900; letter-spacing: -0.5px; color: #ffffff; text-transform: none;">
                  Foto<span style="color: #f59e0b;">Set</span>Go
                </span>
              </div>
              <p style="margin: 8px 0 0; color: #9ca3af; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 700;">
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
      const updatedPhotographer = await tx.photographer.update({
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

  async login(credentials: { email: string; password: string }, requestInfo?: { ipAddress?: string; userAgent?: string }) {
    const normalizedEmail = (credentials.email || '').toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { photographer: true },
    });

    const parsedUA = this.parseUserAgent(requestInfo?.userAgent || '');
    const ipAddress = requestInfo?.ipAddress || '127.0.0.1';

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
      throw new UnauthorizedException('Invalid credentials');
    }

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
      throw new UnauthorizedException('Invalid credentials');
    }

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

  async adminLogin(credentials: { email: string; password: string }, requestInfo?: { ipAddress?: string; userAgent?: string }) {
    const normalizedEmail = (credentials.email || '').toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid admin credentials.');
    }

    if (user.role !== 'ADMIN') {
      throw new UnauthorizedException('Access denied. This account does not have administrator privileges.');
    }

    const passwordMatch = await bcrypt.compare(credentials.password, user.passwordHash);
    if (!passwordMatch) {
      throw new UnauthorizedException('Invalid admin credentials.');
    }

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
    return this.prisma.$transaction(async (tx) => {
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
            bio: data.bio,
            website: data.website,
            videoFaceScanningEnabled: data.videoFaceScanningEnabled !== undefined ? data.videoFaceScanningEnabled : undefined,
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
