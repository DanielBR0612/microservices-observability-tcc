import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

// O exportador envia os dados para o Jaeger via gRPC
const exporter = new OTLPTraceExporter({
  url: 'grpc://jaeger:4317', // Usa o nome do container do docker-compose
});

const sdk = new NodeSDK({
  traceExporter: exporter,
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
console.log('OpenTelemetry inicializado');