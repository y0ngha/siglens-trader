CREATE INDEX IF NOT EXISTS idx_analysis_symbol_type_date ON analysis_results (symbol, analysis_type, analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_symbol_status ON positions (symbol, status);
CREATE INDEX IF NOT EXISTS idx_trades_executed_at ON trades (executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pending_orders_status ON pending_orders (status, expires_at);
