import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../users/user.entity';
import { LoginDto, RegisterDto } from './auth.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  private publicUser(u: User) {
    return { id: u.id, name: u.name, email: u.email };
  }

  private async tokenFor(u: User) {
    return { accessToken: await this.jwt.signAsync({ sub: u.id, email: u.email }), user: this.publicUser(u) };
  }

  async register(dto: RegisterDto) {
    if (await this.users.findOne({ where: { email: dto.email } })) {
      throw new ConflictException('Email sudah terdaftar');
    }
    const user = await this.users.save(
      this.users.create({
        name: dto.name.trim(),
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, 10),
      }),
    );
    return this.tokenFor(user);
  }

  async login(dto: LoginDto) {
    const user = await this.users.findOne({ where: { email: dto.email } });
    // Pesan sama untuk email/password salah agar tidak membocorkan akun yang terdaftar.
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Email atau password salah');
    }
    return this.tokenFor(user);
  }

  async me(id: string) {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Pengguna tidak ditemukan');
    return this.publicUser(user);
  }
}
