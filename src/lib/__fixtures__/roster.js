// src/lib/__fixtures__/roster.js — the real seeded 22-advisor roster, mirrored
// here verbatim from scripts/seed.js so the pure-function tests can run without
// Firebase. If the seed roster changes, update this snapshot to match.

export const ROSTER = [
  { id: 'worker-01', firstName: 'Maria', lastName: 'Alvarez', eaLevel: 1, programs: { snap: true, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-02', firstName: 'James', lastName: 'Bennett', eaLevel: 2, programs: { snap: true, tanf: false, mepd: false, medicaid: false }, active: true },
  { id: 'worker-03', firstName: 'Priya', lastName: 'Chen', eaLevel: 1, programs: { snap: true, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-04', firstName: 'David', lastName: 'Diaz', eaLevel: 2, programs: { snap: true, tanf: false, mepd: false, medicaid: true }, active: true },
  { id: 'worker-05', firstName: 'Aisha', lastName: 'Edwards', eaLevel: 1, programs: { snap: true, tanf: true, mepd: true, medicaid: true }, active: true },
  { id: 'worker-06', firstName: 'Robert', lastName: 'Foster', eaLevel: 3, programs: { snap: true, tanf: false, mepd: false, medicaid: false }, active: true },
  { id: 'worker-07', firstName: 'Linda', lastName: 'Garcia', eaLevel: 1, programs: { snap: true, tanf: true, mepd: false, medicaid: false }, active: true },
  { id: 'worker-08', firstName: 'Kevin', lastName: 'Hill', eaLevel: 2, programs: { snap: false, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-09', firstName: 'Sarah', lastName: 'Ibarra', eaLevel: 1, programs: { snap: true, tanf: false, mepd: true, medicaid: true }, active: true },
  { id: 'worker-10', firstName: 'Marcus', lastName: 'Jones', eaLevel: 2, programs: { snap: true, tanf: true, mepd: false, medicaid: false }, active: true },
  { id: 'worker-11', firstName: 'Nina', lastName: 'Khan', eaLevel: 1, programs: { snap: true, tanf: false, mepd: false, medicaid: true }, active: true },
  { id: 'worker-12', firstName: 'Tom', lastName: 'Lopez', eaLevel: 3, programs: { snap: false, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-13', firstName: 'Grace', lastName: 'Martin', eaLevel: 1, programs: { snap: true, tanf: true, mepd: true, medicaid: true }, active: true },
  { id: 'worker-14', firstName: 'Omar', lastName: 'Nguyen', eaLevel: 2, programs: { snap: true, tanf: false, mepd: false, medicaid: false }, active: true },
  { id: 'worker-15', firstName: 'Beth', lastName: 'Owens', eaLevel: 1, programs: { snap: true, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-16', firstName: 'Carlos', lastName: 'Perez', eaLevel: 2, programs: { snap: false, tanf: false, mepd: false, medicaid: true }, active: true },
  { id: 'worker-17', firstName: 'Dana', lastName: 'Quinn', eaLevel: 1, programs: { snap: true, tanf: true, mepd: false, medicaid: false }, active: true },
  { id: 'worker-18', firstName: 'Eric', lastName: 'Reed', eaLevel: 3, programs: { snap: true, tanf: false, mepd: false, medicaid: true }, active: true },
  { id: 'worker-19', firstName: 'Fatima', lastName: 'Silva', eaLevel: 1, programs: { snap: true, tanf: false, mepd: true, medicaid: false }, active: true },
  { id: 'worker-20', firstName: 'Henry', lastName: 'Tucker', eaLevel: 2, programs: { snap: true, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-21', firstName: 'Iris', lastName: 'Vance', eaLevel: 1, programs: { snap: false, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-22', firstName: 'Jack', lastName: 'Wong', eaLevel: 2, programs: { snap: true, tanf: false, mepd: false, medicaid: false }, active: true },
]
