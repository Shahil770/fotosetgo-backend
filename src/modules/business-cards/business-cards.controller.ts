import { Controller, Get, Post, Patch, Body, Param, UseGuards, Res } from '@nestjs/common';
import { BusinessCardsService, SaveBusinessCardDto } from './business-cards.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('business-cards')
export class BusinessCardsController {
  constructor(private readonly businessCardsService: BusinessCardsService) {}

  private getPhotographerId(user: any): string {
    return user.photographer?.id || user.photographerId || user.id;
  }

  @Get('themes')
  async getCardThemes() {
    return this.businessCardsService.getCardThemes(false);
  }

  @Get('themes/admin')
  @UseGuards(JwtAuthGuard)
  async getCardThemesAdmin() {
    return this.businessCardsService.getCardThemes(true);
  }

  @Patch('themes/:id/toggle')
  @UseGuards(JwtAuthGuard)
  async toggleCardTheme(@Param('id') id: string, @Body() body: { isActive: boolean }) {
    return this.businessCardsService.toggleCardTheme(id, body.isActive);
  }

  @UseGuards(JwtAuthGuard)
  @Get('my-card')
  async getMyBusinessCard(@CurrentUser() user: any) {
    const photographerId = this.getPhotographerId(user);
    return this.businessCardsService.getMyBusinessCard(photographerId);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async saveBusinessCard(@CurrentUser() user: any, @Body() dto: SaveBusinessCardDto) {
    const photographerId = this.getPhotographerId(user);
    return this.businessCardsService.saveBusinessCard(photographerId, dto);
  }
}

@Controller('public/c')
export class PublicBusinessCardsController {
  constructor(private readonly businessCardsService: BusinessCardsService) {}

  @Get(':slug')
  async getPublicBusinessCard(@Param('slug') slug: string) {
    return this.businessCardsService.getPublicBusinessCardBySlug(slug);
  }

  @Get(':slug/vcard')
  async downloadVCard(@Param('slug') slug: string, @Res() res: any) {
    const cardData = await this.businessCardsService.getPublicBusinessCardBySlug(slug);
    const vcardStr = this.businessCardsService.generateVCardString(cardData);
    
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-contact.vcf"`);
    return res.send(vcardStr);
  }
}
