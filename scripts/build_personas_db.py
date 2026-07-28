"""Nemotron-Personas-Korea parquet -> compact dev SQLite (stratified sample).
Mirrors korean-people-persona: province×sex proportional (largest remainder).
Run via: uv run --python 3.12 --with pyarrow scripts/build_personas_db.py
"""
import sqlite3, random, math, os
from pathlib import Path
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "train-00000-of-00009.parquet"
DB = ROOT / "data" / "personas.db"
# Corpus must be >> max sample size (supports representative samples up to ~10k).
N = int(os.environ.get("LOOP_PERSONA_SAMPLE_N", "50000"))
random.seed(42)

COLS = ["uuid","persona","professional_persona","family_persona","culinary_persona",
        "hobbies_and_interests","career_goals_and_ambitions","skills_and_expertise",
        "cultural_background","sex","age","marital_status","family_type","housing_type",
        "education_level","bachelors_field","occupation","district","province"]

t = pq.read_table(SRC, columns=COLS)
rows = t.to_pylist()
print(f"loaded rows: {len(rows)}")

# group by (province, sex)
from collections import defaultdict
groups = defaultdict(list)
for r in rows:
    groups[(r["province"], r["sex"])].append(r)

total = len(rows)
raw = [(k, len(v), N*len(v)/total) for k,v in groups.items()]
quotas = {k:int(q) for k,_,q in raw}
rem = N - sum(quotas.values())
for k,_,q in sorted(raw, key=lambda x: x[2]-int(x[2]), reverse=True)[:rem]:
    quotas[k]+=1

sample=[]
for k,members in groups.items():
    q=min(quotas.get(k,0), len(members))
    if q>0: sample.extend(random.sample(members,q))
random.shuffle(sample)
print(f"sampled: {len(sample)} across {len([k for k in quotas if quotas[k]>0])} province×sex cells")

DB.unlink(missing_ok=True)
con=sqlite3.connect(DB)
con.execute(f"CREATE TABLE persona ({', '.join(c+' TEXT' for c in COLS)})")
con.execute("CREATE INDEX idx_demo ON persona(province, sex, age, occupation)")
con.executemany(f"INSERT INTO persona ({','.join(COLS)}) VALUES ({','.join('?'*len(COLS))})",
                [[str(r[c]) for c in COLS] for r in sample])
con.commit()
print("db size:", round(DB.stat().st_size/1e6,1), "MB")
print("sample provinces:", con.execute("SELECT province, count(*) FROM persona GROUP BY province ORDER BY 2 DESC LIMIT 5").fetchall())
con.close()
