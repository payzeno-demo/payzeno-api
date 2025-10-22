/**
 * ReportingModule.
 *
 * Imports LedgerModule for the balance and payout reads and PaymentsModule for nothing more
 * than the entity metadata `VolumeTimeseriesQuery` reads through the shared DataSource — the
 * raw SQL in that file names `charge` and `dispute` directly, so the tables must be
 * registered somewhere in the graph before this module is instantiated.
 */
import { Module } from '@nestjs/common';
