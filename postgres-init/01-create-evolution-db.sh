#!/usr/bin/env bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  SELECT 'CREATE DATABASE "$EVOLUTION_POSTGRES_DB"'
  WHERE NOT EXISTS (
    SELECT FROM pg_database WHERE datname = '$EVOLUTION_POSTGRES_DB'
  )\gexec
EOSQL
