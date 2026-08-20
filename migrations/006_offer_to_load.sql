-- 006_offer_to_load.sql
--
-- Make the supply run flow one-directional.
--
-- Until now a run was a page of loose forms: you could buy a load from any
-- supplier at any time, whether or not they had ever made an offer, and the
-- offers table sat beside the purchases table with nothing joining them. The
-- officer had to hold the sequence in his head, and the two halves of the screen
-- could disagree about who you were even buying from.
--
-- A load is now the RESULT of an accepted offer. You record what a farm is
-- asking, you compare, you accept one, and only then can you weigh and buy it.
-- Every purchase therefore carries the offer it came from, which also means the
-- price agreed at the gate can always be read against the price first quoted.

ALTER TABLE spot_purchase ADD COLUMN offer_id INTEGER REFERENCES run_offer(id);

-- An accepted offer converts into exactly one load. Buying twice against the
-- same offer is a double entry, not a second purchase.
CREATE UNIQUE INDEX spot_purchase_one_per_offer
  ON spot_purchase(offer_id) WHERE offer_id IS NOT NULL;

-- Every NEW load must come from an accepted offer on the same run.
--
-- Deliberately BEFORE INSERT only: loads recorded before this migration have no
-- offer behind them and are left alone. History is not rewritten to match a
-- rule that did not exist when it happened.
CREATE TRIGGER spot_purchase_needs_accepted_offer BEFORE INSERT ON spot_purchase
WHEN NEW.offer_id IS NULL
  OR (SELECT status FROM run_offer WHERE id = NEW.offer_id) <> 'Accepted'
  OR (SELECT run_id  FROM run_offer WHERE id = NEW.offer_id) <> NEW.run_id
BEGIN
  SELECT RAISE(ABORT,
    'a load must come from an offer accepted on this run: record the offer and accept it first');
END;

-- An offer that has become a load is settled business. It cannot be declined
-- afterwards, and it cannot be re-priced to disagree with what was paid.
CREATE TRIGGER run_offer_bought_cannot_be_declined BEFORE UPDATE ON run_offer
WHEN NEW.status <> 'Accepted'
 AND EXISTS (SELECT 1 FROM spot_purchase p
              WHERE p.offer_id = OLD.id AND p.voided_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'this offer has already been bought: void the load first');
END;

CREATE TRIGGER run_offer_bought_cannot_be_repriced BEFORE UPDATE ON run_offer
WHEN NEW.asking_price_cents <> OLD.asking_price_cents
 AND EXISTS (SELECT 1 FROM spot_purchase p
              WHERE p.offer_id = OLD.id AND p.voided_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'this offer has already been bought and cannot be re-priced');
END;
