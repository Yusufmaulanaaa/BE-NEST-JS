import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../common/auth';
import { CreateReviewDto, LawyerQueryDto } from './lawyers.dto';
import { LawyersService } from './lawyers.service';
import { AuthService } from '../auth/auth.service';

@ApiTags('lawyers')
@Controller('lawyers')
export class LawyersController {
  constructor(
    private readonly lawyers: LawyersService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  search(@Query() query: LawyerQueryDto) {
    return this.lawyers.search(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.lawyers.findOne(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post(':id/reviews')
  async review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateReviewDto,
  ) {
    const me = await this.auth.me(user.id);
    return this.lawyers.addReview(id, { id: me.id, name: me.name }, dto);
  }
}
