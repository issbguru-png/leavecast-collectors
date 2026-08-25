-- Leavecast schema, plain-Postgres variant (Neon has no TimescaleDB).
-- Same design as schema.sql: readings is append-only forever; hourly rollups
-- are maintained by the collector job after each write batch.

CREATE TABLE IF NOT EXISTS airports (
  iata        text PRIMARY KEY CHECK (iata ~ '^[A-Z]{3}$'),
  icao        text,
  name        text NOT NULL,
  city        text,
  state       text,
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  size        text NOT NULL CHECK (size IN ('large','medium','small')),
  nws_office  text,
  nws_grid_x  int,
  nws_grid_y  int,
  terminals   jsonb
);

CREATE TABLE IF NOT EXISTS readings (
  ts       timestamptz NOT NULL,
  airport  text        NOT NULL,
  source   text        NOT NULL CHECK (source IN ('tsawaittimes','faa','nws','cbp','firstparty')),
  kind     text        NOT NULL CHECK (kind IN ('security_wait','faa_status','weather','customs_wait')),
  payload  jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS readings_airport_kind_ts ON readings (airport, kind, ts DESC);
CREATE INDEX IF NOT EXISTS readings_ts ON readings (ts);

-- latest reading per airport+kind, kept current by upsert from the collector job
CREATE TABLE IF NOT EXISTS latest (
  airport  text NOT NULL,
  kind     text NOT NULL,
  ts       timestamptz NOT NULL,
  source   text NOT NULL,
  payload  jsonb NOT NULL,
  PRIMARY KEY (airport, kind)
);

-- observed hourly curves (the moat): refreshed incrementally by the job
CREATE TABLE IF NOT EXISTS security_wait_hourly (
  airport   text NOT NULL,
  dow       int  NOT NULL,           -- 0=Sun..6=Sat (UTC)
  hour      int  NOT NULL,           -- 0..23 (UTC)
  n         bigint NOT NULL DEFAULT 0,
  sum_wait  double precision NOT NULL DEFAULT 0,
  max_wait  double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (airport, dow, hour)
);
