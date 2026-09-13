import { Controller, Post, Body, Get, UseGuards, Put, Req, Delete, Param } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('signup')
  async signup(@Body() body: any) {
    return this.authService.signup(body);
  }

  @Post('send-signup-otp')
  async sendSignupOtp(@Body() body: { email: string; name?: string }) {
    return this.authService.sendSignupOtp(body.email, body.name);
  }

  @Post('verify-and-signup')
  async verifyAndSignup(@Body() body: any, @Req() req: any) {
    const ipAddress = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || '';
    return this.authService.verifyAndSignup(body, { ipAddress, userAgent });
  }

  @Post('forgot-password')
  async forgotPassword(@Body() body: { email: string }) {
    return this.authService.sendForgotPasswordOtp(body.email);
  }

  @Post('verify-forgot-password-otp')
  async verifyForgotPasswordOtp(@Body() body: { email: string; otp: string }) {
    return this.authService.verifyForgotPasswordOtp(body.email, body.otp);
  }

  @Post('reset-password')
  async resetPassword(@Body() body: { email: string; otp: string; newPassword: string }) {
    return this.authService.resetPassword(body);
  }

  @Post('login')
  async login(@Body() body: any, @Req() req: any) {
    const ipAddress = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || '';
    return this.authService.login(body, { ipAddress, userAgent });
  }

  @Post('google')
  async googleAuth(@Body() body: { credential: string; referralCode?: string }, @Req() req: any) {
    const ipAddress = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || '';
    return this.authService.googleAuth(body, { ipAddress, userAgent });
  }

  @Post('admin/login')
  async adminLogin(@Body() body: any, @Req() req: any) {
    const ipAddress = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Admin Console';
    return this.authService.adminLogin(body, { ipAddress, userAgent });
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async getProfile(@CurrentUser() user: any) {
    return user;
  }

  @UseGuards(JwtAuthGuard)
  @Put('profile')
  async updateProfile(@CurrentUser() user: any, @Body() body: any) {
    return this.authService.updateProfile(user.id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(@CurrentUser() user: any, @Body() body: any) {
    return this.authService.changePassword(user.id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  async getSessions(@CurrentUser() user: any) {
    return this.authService.getSessions(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('sessions/:id')
  async revokeSession(@CurrentUser() user: any, @Param('id') id: string) {
    return this.authService.revokeSession(user.id, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('sessions/logout')
  async logoutSession(@CurrentUser() user: any, @Req() req: any) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/bearer\s+/i, '');
    return this.authService.logoutSession(user.id, token);
  }

  @UseGuards(JwtAuthGuard)
  @Get('login-activity')
  async getLoginActivity(@CurrentUser() user: any) {
    return this.authService.getLoginActivity(user.id);
  }
}
