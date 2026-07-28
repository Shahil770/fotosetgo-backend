import { Injectable, ConflictException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async signup(data: { email: string; password: string; name: string; studioName?: string }) {
    const existing = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Math.floor(1000 + Math.random() * 9000);

    // Create user and photographer profile in transaction
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: data.email,
          passwordHash,
          name: data.name,
          role: 'PHOTOGRAPHER',
        },
      });

      const photographer = await tx.photographer.create({
        data: {
          userId: user.id,
          studioName: data.studioName || `${data.name}'s Studio`,
          slug,
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
            maxStorageGb: 0, // representing 200 MB limit
            maxPhotosPerEvent: 100,
            faceSearchLimit: 100,
            allowCustomBranding: false,
            price: 0,
            isActive: true,
          },
        });
      }

      // Create a subscription with 200 MB storage limit (209715200 bytes)
      const limitBytes = BigInt(200 * 1024 * 1024);
      await tx.subscription.create({
        data: {
          photographerId: photographer.id,
          packageId: freePackage.id,
          startsAt: new Date(),
          endsAt: new Date(new Date().setFullYear(new Date().getFullYear() + 10)), // 10 years
          status: 'ACTIVE',
          limitBytes,
          usedBytes: BigInt(0),
        },
      });

      // Update photographer profile with active package ID
      await tx.photographer.update({
        where: { id: photographer.id },
        data: {
          activePackageId: freePackage.id,
        },
      });

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
    const user = await this.prisma.user.findUnique({
      where: { email: credentials.email },
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
