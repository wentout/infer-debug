import { Controller, Get, Param } from '@nestjs/common';

@Controller()
export class OrdersController {
  @Get('api/orders/:id')
  getOrder(@Param('id') id: string): { id: string; pid: number } {
    return { id, pid: process.pid };
  }

  @Get('healthcheck')
  healthcheck(): { status: string; pid: number } {
    return { status: 'ok', pid: process.pid };
  }
}
