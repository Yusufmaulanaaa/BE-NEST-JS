import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

process.env.JWT_SECRET = 'test-secret-for-e2e';
process.env.SQLITE_PATH = ':memory:';
delete process.env.ANTHROPIC_API_KEY;

function tomorrow() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('HukumIn API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token = '';
  let lawyerId = '';
  let bookingId = '';
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
  });
  afterAll(async () => app.close());

  it('health', async () => {
    await http.get('/api/health').expect(200);
  });

  it('register, duplicate, login, me', async () => {
    const body = { name: 'Alex', email: 'Alex@Example.com', password: 'password123' };
    const reg = await http.post('/api/auth/register').send(body).expect(201);
    expect(reg.body.user.email).toBe('alex@example.com');
    expect(reg.body.user.passwordHash).toBeUndefined();
    await http.post('/api/auth/register').send(body).expect(409);
    await http.post('/api/auth/login').send({ email: 'alex@example.com', password: 'salah-salah' }).expect(401);
    const login = await http.post('/api/auth/login').send({ email: 'alex@example.com', password: 'password123' }).expect(201);
    token = login.body.accessToken;
    const me = await http.get('/api/auth/me').set(auth()).expect(200);
    expect(me.body.name).toBe('Alex');
  });

  it('validation rejects bad input and unknown fields', async () => {
    await http.post('/api/auth/register').send({ name: 'A', email: 'x', password: '1' }).expect(400);
    await http.post('/api/auth/login').send({ email: 'a@b.co', password: 'x', admin: true }).expect(400);
  });

  it('lawyers: search, filter, detail', async () => {
    const all = await http.get('/api/lawyers').expect(200);
    expect(all.body.total).toBe(6);
    const f = await http.get('/api/lawyers?specialty=pencurian&sort=price').expect(200);
    expect(f.body.items).toHaveLength(1);
    lawyerId = all.body.items[0].id;
    const d = await http.get(`/api/lawyers/${lawyerId}`).expect(200);
    expect(Array.isArray(d.body.reviews)).toBe(true);
    await http.get('/api/lawyers?minRating=9').expect(400);
  });

  it('chat requires auth, replies, stores history, recommends lawyers', async () => {
    await http.post('/api/chat/messages').send({ message: 'halo' }).expect(401);
    const r1 = await http.post('/api/chat/messages').set(auth()).send({ message: 'Saya ditipu rekan bisnis' }).expect(201);
    expect(r1.body.message.role).toBe('assistant');
    expect(r1.body.lawyers[0].specialty).toBe('Penipuan & Penggelapan');
    const cid = r1.body.conversationId;
    await http.post('/api/chat/messages').set(auth()).send({ conversationId: cid, message: 'Buktinya chat WhatsApp' }).expect(201);
    const detail = await http.get(`/api/chat/conversations/${cid}`).set(auth()).expect(200);
    expect(detail.body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const list = await http.get('/api/chat/conversations').set(auth()).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('chat conversations are private to their owner', async () => {
    const other = await http.post('/api/auth/register').send({ name: 'Budi', email: 'budi@example.com', password: 'password123' }).expect(201);
    const mine = await http.get('/api/chat/conversations').set(auth());
    await http
      .get(`/api/chat/conversations/${mine.body[0].id}`)
      .set({ Authorization: `Bearer ${other.body.accessToken}` })
      .expect(404);
  });

  it('bookings: slots, create, conflict, notify, reschedule, cancel', async () => {
    const date = tomorrow();
    const slots = await http.get(`/api/bookings/slots?lawyerId=${lawyerId}&date=${date}`).set(auth()).expect(200);
    expect(slots.body.every((s: any) => s.available)).toBe(true);

    const payload = { lawyerId, date, time: '10:00', type: 'video', note: 'Kasus penipuan' };
    const b = await http.post('/api/bookings').set(auth()).send(payload).expect(201);
    bookingId = b.body.id;
    expect(b.body.totalPrice).toBeGreaterThan(0);
    await http.post('/api/bookings').set(auth()).send(payload).expect(409);
    await http.post('/api/bookings').set(auth()).send({ ...payload, time: '12:00' }).expect(400);
    await http.post('/api/bookings').set(auth()).send({ ...payload, date: '2020-01-01' }).expect(400);

    const after = await http.get(`/api/bookings/slots?lawyerId=${lawyerId}&date=${date}`).set(auth());
    expect(after.body.find((s: any) => s.time === '10:00').available).toBe(false);

    const notif = await http.get('/api/notifications').set(auth()).expect(200);
    expect(notif.body.unreadCount).toBe(1);
    const read = await http.patch('/api/notifications/read-all').set(auth()).expect(200);
    expect(read.body.unreadCount).toBe(0);

    await http.patch(`/api/bookings/${bookingId}/reschedule`).set(auth()).send({ date, time: '11:00' }).expect(200);
    const cancelled = await http.patch(`/api/bookings/${bookingId}/cancel`).set(auth()).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    await http.patch(`/api/bookings/${bookingId}/cancel`).set(auth()).expect(400);
    const mine = await http.get('/api/bookings?status=cancelled').set(auth()).expect(200);
    expect(mine.body).toHaveLength(1);
  });

  it('reviews: create updates rating, duplicate rejected', async () => {
    const before = await http.get(`/api/lawyers/${lawyerId}`).expect(200);
    const r = await http.post(`/api/lawyers/${lawyerId}/reviews`).set(auth()).send({ rating: 5, comment: 'Sangat membantu' }).expect(201);
    expect(r.body.rating).toBe(5);
    const after = await http.get(`/api/lawyers/${lawyerId}`).expect(200);
    expect(after.body.reviewCount).toBe(before.body.reviewCount + 1);
    expect(after.body.reviews[0].userName).toBe('Alex');
    await http.post(`/api/lawyers/${lawyerId}/reviews`).set(auth()).send({ rating: 4 }).expect(409);
    await http.post(`/api/lawyers/${lawyerId}/reviews`).set(auth()).send({ rating: 9 }).expect(400);
  });

  it('delete conversation', async () => {
    const list = await http.get('/api/chat/conversations').set(auth());
    await http.delete(`/api/chat/conversations/${list.body[0].id}`).set(auth()).expect(204);
    const again = await http.get('/api/chat/conversations').set(auth());
    expect(again.body).toHaveLength(0);
  });
});
