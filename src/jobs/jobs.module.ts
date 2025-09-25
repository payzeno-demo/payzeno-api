/**
 * JobsModule — the background surface.
 *
 * One line per job, nine jobs, twelve months. Every job is registered here and nowhere else,
 * and `ScheduleModule.forRoot()` is imported exactly once in the application — if it is
 * imported twice, Nest registers every cron twice in the same task and the Redis lease is the
 * only thing standing between you and double execution.
 *
