/**
 * CustomersModule — RFC platform-v2 §5: `customer` and `payment_method`.
 *
 * Imports PaymentsModule for the VaultClient (a card is saved from what the vault resolves a
 * token to). Exports both services: checkout saves cards and creates customers, subscriptions
 * charge saved cards.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '../common/common.module';
import { PaymentMethodEntity } from '../payment-methods/payment-method.entity';
import { PaymentMethodRepository } from '../payment-methods/payment-method.repository';
import { PaymentMethodsService } from '../payment-methods/payment-methods.service';
import { PaymentsModule } from '../payments/payments.module';

import { CustomerEntity } from './customer.entity';
import { CustomerRepository } from './customer.repository';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [CommonModule, PaymentsModule, TypeOrmModule.forFeature([CustomerEntity, PaymentMethodEntity])],
  controllers: [CustomersController],
  providers: [CustomersService, CustomerRepository, PaymentMethodsService, PaymentMethodRepository],
  exports: [CustomersService, CustomerRepository, PaymentMethodsService, PaymentMethodRepository],
})
export class CustomersModule {}
