import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

export class CreateBookingDto {
  @IsUUID() lawyerId: string;
  @Matches(DATE, { message: 'date harus berformat YYYY-MM-DD' }) date: string;
  @Matches(TIME, { message: 'time harus berformat HH:mm' }) time: string;
  @IsIn(['video', 'voice', 'in_person']) type: 'video' | 'voice' | 'in_person';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class RescheduleDto {
  @Matches(DATE, { message: 'date harus berformat YYYY-MM-DD' }) date: string;
  @Matches(TIME, { message: 'time harus berformat HH:mm' }) time: string;
}

export class SlotsQueryDto {
  @IsUUID() lawyerId: string;
  @Matches(DATE, { message: 'date harus berformat YYYY-MM-DD' }) date: string;
}

export class BookingListQueryDto {
  @IsOptional() @IsIn(['upcoming', 'completed', 'cancelled']) status?: string;
}
