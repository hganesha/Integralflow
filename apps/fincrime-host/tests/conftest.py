import pytest

from financial_crime import synthetic
from financial_crime.contracts import canonical
from financial_crime.execution import Executor
from financial_crime.store import Store


@pytest.fixture
def environment():
    store = Store()
    synthetic.seed(store)
    store.set_state("tenant-synthetic", "case", "case-demo", 0, {"state": "OPEN", "case_type": "KYB"})
    store.db.execute("INSERT INTO outbox VALUES(?,?,?,?,?,?)", ("tenant-synthetic", "submission-1", "hash", "CONFIRMED", "{}", canonical({"receipt_id": "synthetic-receipt"})))
    executor = Executor(store, [synthetic.profile()], synthetic.router())
    yield store, executor, synthetic.principal()
    store.close()

