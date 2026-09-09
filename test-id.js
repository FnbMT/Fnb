const d = { id: 'firestore_real_id', data: () => ({ id: 'random_fake_id', name: 'test' }) };
const obj = { id: d.id, ...d.data() };
console.log(obj);
