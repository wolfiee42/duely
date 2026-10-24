-- No RLS and no app access: the web role never sees mail that belongs to no firm.
grant select, insert, delete on unrouted_inbound to duely_system;
