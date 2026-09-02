import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { IsOptional, IsString, IsArray } from 'class-validator';
import { PrismaService } from '../../prisma.service';
import Redis from 'ioredis';

export class SaveBusinessCardDto {
  @IsOptional()
  @IsString()
  theme?: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  jobTitle?: string;

  @IsOptional()
  @IsString()
  tagline?: string;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  whatsapp?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  website?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  instagram?: string;

  @IsOptional()
  @IsString()
  facebook?: string;

  @IsOptional()
  @IsString()
  youtube?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsArray()
  customLinks?: any[];
}

@Injectable()
export class BusinessCardsService {
  private readonly logger = new Logger(BusinessCardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis
  ) {
    this.startCardViewsSyncProcessor();
  }

  private startCardViewsSyncProcessor() {
    setInterval(async () => {
      try {
        await this.syncAggregatedCardViews();
      } catch (err: any) {
        this.logger.error(`[CardViewsSync] Error in periodic sync: ${err.message}`);
      }
    }, 10000); // sync every 10 seconds
  }

  private async syncAggregatedCardViews() {
    try {
      const viewsMap = await this.redis.hgetall('agg:businessCard:views');
      if (!viewsMap || Object.keys(viewsMap).length === 0) return;

      for (const [cardId, countStr] of Object.entries(viewsMap)) {
        const count = parseInt(countStr, 10);
        if (count > 0) {
          await this.prisma.businessCard.update({
            where: { id: cardId },
            data: { viewsCount: { increment: count } }
          }).catch(err => this.logger.error(`[CardViewsSync] Failed to update card ${cardId}: ${err.message}`));
          await this.redis.hincrby('agg:businessCard:views', cardId, -count).catch(() => {});
        }
      }
    } catch (err: any) {
      this.logger.error(`[CardViewsSync] Error in syncAggregatedCardViews: ${err.message}`);
    }
  }

  async getCardThemes(includeInactive = false) {
    return this.prisma.cardTheme.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { sortOrder: 'asc' }
    });
  }

  async toggleCardTheme(id: string, isActive: boolean) {
    return this.prisma.cardTheme.update({
      where: { id },
      data: { isActive }
    });
  }

  async getMyBusinessCard(photographerId: string) {
    let card = await this.prisma.businessCard.findUnique({
      where: { photographerId }
    });

    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      include: {
        user: { select: { name: true, email: true } },
        subscriptions: {
          where: { status: 'ACTIVE' },
          include: { package: true }
        }
      }
    });

    const activeSub = photographer?.subscriptions?.[0];
    const hasBranding = activeSub?.package ? activeSub.package.featureCustomBranding : false;

    if (!card && photographer) {
      // Auto-create initial digital business card with photographer's studio defaults
      const slug = (hasBranding && photographer.studioSubdomain) 
        ? photographer.studioSubdomain 
        : `card-${photographerId.slice(0, 8)}`;
      card = await this.prisma.businessCard.create({
        data: {
          photographerId,
          slug,
          displayName: photographer.studioName || photographer.user?.name || 'Studio Owner',
          jobTitle: 'Professional Wedding & Event Photographer',
          tagline: photographer.bio || 'Capturing timeless memories & candid emotion',
          bio: photographer.bio || 'Award-winning wedding and lifestyle photography studio.',
          phone: photographer.whatsappPhone || '',
          whatsapp: photographer.whatsappPhone || '',
          email: photographer.portfolioEmail || photographer.user?.email || '',
          website: photographer.website || `https://${slug}.fotosetgo.com`,
          city: photographer.city || 'India',
          instagram: photographer.instagramUrl || '',
          facebook: photographer.facebookUrl || '',
          address: photographer.portfolioAddress || ''
        }
      });
    }

    return { card, photographer };
  }

  async saveBusinessCard(photographerId: string, dto: SaveBusinessCardDto) {
    let card = await this.prisma.businessCard.findUnique({
      where: { photographerId }
    });

    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          include: { package: true }
        }
      }
    });

    const activeSub = photographer?.subscriptions?.[0];
    const hasBranding = activeSub?.package ? activeSub.package.featureCustomBranding : false;

    let slug = card?.slug;

    if (!hasBranding) {
      // Free plan: use neutral card ID slug
      slug = `card-${photographerId.slice(0, 8)}`;
    } else {
      // PRO plan with branding: derive slug directly from Branding Settings (studioSubdomain)
      const targetBase = (photographer?.studioSubdomain || photographer?.slug || dto.displayName || `studio-${photographerId.slice(0, 6)}`)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      let candidateSlug = targetBase || `card-${photographerId.slice(0, 8)}`;
      
      // Ensure candidate slug is unique across other business cards
      let counter = 1;
      while (true) {
        const existingCard = await this.prisma.businessCard.findFirst({
          where: {
            slug: candidateSlug,
            NOT: { photographerId }
          }
        });
        if (!existingCard) {
          slug = candidateSlug;
          break;
        }
        candidateSlug = `${targetBase}-${counter}`;
        counter++;
      }
    }

    const savedCard = await this.prisma.businessCard.upsert({
      where: { photographerId },
      create: {
        photographerId,
        slug,
        theme: dto.theme || 'ROYAL_BRUSHED_GOLD',
        displayName: dto.displayName,
        jobTitle: dto.jobTitle,
        tagline: dto.tagline,
        bio: dto.bio,
        phone: dto.phone,
        whatsapp: dto.whatsapp,
        email: dto.email,
        website: dto.website,
        city: dto.city,
        instagram: dto.instagram,
        facebook: dto.facebook,
        youtube: dto.youtube,
        address: dto.address,
        customLinks: dto.customLinks ? dto.customLinks : []
      },
      update: {
        slug,
        theme: dto.theme,
        displayName: dto.displayName,
        jobTitle: dto.jobTitle,
        tagline: dto.tagline,
        bio: dto.bio,
        phone: dto.phone,
        whatsapp: dto.whatsapp,
        email: dto.email,
        website: dto.website,
        city: dto.city,
        instagram: dto.instagram,
        facebook: dto.facebook,
        youtube: dto.youtube,
        address: dto.address,
        customLinks: dto.customLinks ? dto.customLinks : []
      }
    });

    // Invalidate Redis card caches
    try {
      if (savedCard.slug) await this.redis.del(`cache:public:card:${savedCard.slug.toLowerCase().trim()}`);
      if (savedCard.id) await this.redis.del(`cache:public:card:${savedCard.id.toLowerCase().trim()}`);
      if (card?.slug && card.slug !== savedCard.slug) await this.redis.del(`cache:public:card:${card.slug.toLowerCase().trim()}`);
    } catch (err: any) {
      this.logger.error(`[saveBusinessCard] Redis cache del error: ${err.message}`);
    }

    return savedCard;
  }

  async getPublicBusinessCardBySlug(slugOrId: string) {
    const cleanKey = slugOrId.toLowerCase().trim();
    const cacheKey = `cache:public:card:${cleanKey}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const card = JSON.parse(cached);
        // Increment views count in-memory in Redis hash (Zero Row-Level Locks)
        await this.redis.hincrby('agg:businessCard:views', card.id, 1).catch(() => {});
        return card;
      }
    } catch (err: any) {
      this.logger.error(`[getPublicBusinessCardBySlug] Redis cache get error: ${err.message}`);
    }

    const include = {
      photographer: {
        include: {
          user: { select: { name: true } },
          subscriptions: {
            where: { status: 'ACTIVE' },
            include: { package: true }
          }
        }
      }
    };

    // Try slug first, then fallback to ID lookup
    let card = await this.prisma.businessCard.findUnique({
      where: { slug: slugOrId },
      include
    });

    if (!card) {
      card = await this.prisma.businessCard.findUnique({
        where: { id: slugOrId },
        include
      });
    }

    if (!card) {
      throw new NotFoundException('Digital Business Card not found');
    }

    // Increment views count in Redis hash
    await this.redis.hincrby('agg:businessCard:views', card.id, 1).catch(() => {});

    const activeSub = card.photographer?.subscriptions?.[0];
    const hasBranding = activeSub?.package ? activeSub.package.featureCustomBranding : false;

    if (!hasBranding) {
      // Mask only branding-specific fields (NOT displayName — user can set their own name freely)
      card.instagram = '';
      card.facebook = '';
      card.youtube = '';
      card.website = 'https://fotosetgo.com';
      if (card.photographer) {
        (card.photographer as any).studioName = '';
        (card.photographer as any).studioLogoKey = null;
      }

      // Override slug with card.id → frontend will redirect to /c/{card.id}
      // This hides ALL branding info from the URL completely
      card.slug = card.id;
    }

    try {
      await this.redis.setex(cacheKey, 600, JSON.stringify(card));
      if (card.slug && card.id && card.slug.toLowerCase().trim() !== cleanKey) {
        await this.redis.setex(`cache:public:card:${card.id.toLowerCase().trim()}`, 600, JSON.stringify(card));
      }
    } catch (err: any) {
      this.logger.error(`[getPublicBusinessCardBySlug] Redis cache set error: ${err.message}`);
    }

    return card;
  }

  generateVCardString(card: any): string {
    const fn = card.displayName || 'Photographer';
    const title = card.jobTitle || 'Photographer';
    const phone = card.phone || card.whatsapp || '';
    const email = card.email || '';
    const url = card.website || '';
    const note = card.tagline || card.bio || '';
    const city = card.city || '';

    return [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${fn}`,
      `ORG:${fn}`,
      `TITLE:${title}`,
      phone ? `TEL;TYPE=CELL:${phone}` : '',
      email ? `EMAIL;TYPE=WORK:${email}` : '',
      url ? `URL:${url}` : '',
      city ? `ADR;TYPE=WORK:;;;${city};;;` : '',
      note ? `NOTE:${note}` : '',
      'END:VCARD'
    ].filter(Boolean).join('\r\n');
  }
}
