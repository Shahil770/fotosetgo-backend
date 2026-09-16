import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { EventsService } from './events.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('events')
export class EventsController {
  constructor(private eventsService: EventsService) {}

  @Post()
  async create(@CurrentUser() user: any, @Body() body: any) {
    return this.eventsService.create(user.photographer.id, body);
  }

  @Get()
  async findAll(
    @CurrentUser() user: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.eventsService.findAll(user.photographer.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
      status,
    });
  }

  @Get(':id')
  async findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.eventsService.findOne(user.photographer.id, id);
  }

  @Get(':id/photos')
  async getPhotos(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('photoIds') photoIds?: string,
  ) {
    return this.eventsService.getEventPhotos(user.photographer.id, id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      cursor,
      type,
      search,
      sortBy,
      photoIds,
    });
  }

  @Put(':id')
  async update(@CurrentUser() user: any, @Param('id') id: string, @Body() body: any) {
    return this.eventsService.update(user.photographer.id, id, body);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.eventsService.softDelete(user.photographer.id, id);
  }

  @Post('bulk-trash')
  async bulkTrash(@CurrentUser() user: any, @Body() body: { eventIds: string[] }) {
    return this.eventsService.bulkSoftDelete(user.photographer.id, body.eventIds || []);
  }

  @Post(':id/restore')
  async restore(@CurrentUser() user: any, @Param('id') id: string) {
    return this.eventsService.restore(user.photographer.id, id);
  }

  @Delete(':id/permanent')
  async hardRemove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.eventsService.remove(user.photographer.id, id);
  }
}


