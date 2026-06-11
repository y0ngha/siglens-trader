CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_symbol_open ON positions (symbol) WHERE status = 'open';
