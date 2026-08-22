import './tracing'; 
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'; 
import { HateoasInterceptor } from './common/hateoas.interceptor';
import { WsAdapter } from '@nestjs/platform-ws';
import { NextFunction, Request, Response } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use((req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS,PATCH');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
      
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });
    
  app.enableCors({ origin: '*' });

  app.useWebSocketAdapter(new (WsAdapter as any)(app));
  
  const config = new DocumentBuilder()
    .setTitle('API Gateway Bancário')
    .setDescription('Gateway para integração de serviços Legados (SOAP) e Modernos (REST)')
    .setVersion('1.0')
    .addTag('banco-soap', 'Operações no sistema legado Java')
    .addTag('banco-rest', 'Operações no sistema moderno Kotlin')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document); 

  app.useGlobalInterceptors(new HateoasInterceptor());

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
