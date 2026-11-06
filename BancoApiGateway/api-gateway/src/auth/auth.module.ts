import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { BancoCoreSoapModule } from '../banco-core-soap/banco-core-soap.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      // Mesmo segredo do ws-service, para o token do login abrir o WebSocket
      secret: process.env.JWT_SECRET || 'secret',
      signOptions: { expiresIn: '1h' }, 
    }),
    BancoCoreSoapModule
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService], 
})
export class AuthModule {}