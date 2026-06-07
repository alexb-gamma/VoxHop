import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';

/**
 * SimulatorGateway — WebSocket gateway for browser connections.
 *
 * Phase 1: ack-on-connect only. No message handling, no call logic.
 * Phase 2 will add session management and message routing.
 */
@WebSocketGateway({ path: '/ws/simulator', transports: ['websocket'] })
export class SimulatorGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SimulatorGateway.name);

  handleConnection(client: WebSocket): void {
    this.logger.log('[simulator] browser connected');
    client.send(JSON.stringify({ type: 'ack' }));
  }

  handleDisconnect(): void {
    this.logger.log('[simulator] browser disconnected');
  }
}
