-- Swap the small-cap GPRO for NVDA so all 7 stocks are top-tier, instantly
-- recognizable US names. Updated in place (matched by ticker) so the row keeps
-- its uuid id.
--
-- Composition note: the "same industry, different size" pair is now AAPL + NVDA
-- (both Technology). Size differentiation is intentionally relaxed here — every
-- truly recognizable US tech name is large-cap, and audience recognizability
-- matters more for the competition than having a small-cap in the set. NVDA was
-- explicitly requested. The substitute pair (TSLA vs XOM), complementary pair
-- (MCD / KO), and JPM are unchanged.

update public.instruments
set ticker   = 'NVDA',
    name     = 'NVIDIA Corp',
    category = 'stock',
    sector   = 'Technology'
where ticker = 'GPRO';
