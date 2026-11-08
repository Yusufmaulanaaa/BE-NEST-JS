import { Lawyer } from './lawyer.entity';

type Seed = Omit<Lawyer, 'id' | 'reviews'>;

// Data contoh (fiktif) untuk pengembangan.
export const LAWYER_SEED: Seed[] = [
  { name: 'Michale Chan, S.H.', role: 'Pengacara Pidana', specialty: 'Penipuan & Penggelapan', city: 'Jakarta', rating: 4.8, reviewCount: 102, experienceYears: 10, casesHandled: 219, pricePerHour: 450000, photoUrl: 'https://i.pravatar.cc/150?img=12', about: 'Berpengalaman menangani perkara penipuan dan penggelapan, dari pelaporan hingga persidangan.', verified: true, practiceAreas: ['Penipuan', 'Penggelapan', 'Pidana Ekonomi'] },
  { name: 'Sarah Wijaya, S.H., M.H.', role: 'Pengacara Pidana Umum', specialty: 'Pencurian', city: 'Bandung', rating: 4.9, reviewCount: 88, experienceYears: 8, casesHandled: 174, pricePerHour: 380000, photoUrl: 'https://i.pravatar.cc/150?img=47', about: 'Mendampingi korban dan terlapor dalam perkara pencurian dan pidana umum.', verified: true, practiceAreas: ['Pencurian', 'Pidana Umum'] },
  { name: 'Daniel Prasetyo, S.H.', role: 'Pengacara Pidana', specialty: 'Penganiayaan', city: 'Surabaya', rating: 4.7, reviewCount: 64, experienceYears: 6, casesHandled: 131, pricePerHour: 300000, photoUrl: 'https://i.pravatar.cc/150?img=59', about: 'Fokus pada perkara kekerasan fisik, visum, dan pendampingan korban.', verified: true, practiceAreas: ['Penganiayaan', 'Kekerasan Dalam Rumah Tangga'] },
  { name: 'Anindya Putri, S.H., M.Kn.', role: 'Pengacara UU ITE', specialty: 'Pencemaran Nama Baik', city: 'Jakarta', rating: 4.8, reviewCount: 77, experienceYears: 9, casesHandled: 158, pricePerHour: 420000, photoUrl: 'https://i.pravatar.cc/150?img=45', about: 'Menangani perkara pencemaran nama baik, fitnah, dan sengketa di media sosial.', verified: true, practiceAreas: ['Pencemaran Nama Baik', 'UU ITE'] },
  { name: 'Rizky Hakim, S.H.', role: 'Pengacara Ketenagakerjaan', specialty: 'Ketenagakerjaan', city: 'Yogyakarta', rating: 4.6, reviewCount: 51, experienceYears: 7, casesHandled: 109, pricePerHour: 275000, photoUrl: 'https://i.pravatar.cc/150?img=15', about: 'Membantu pekerja dalam sengketa PHK, pesangon, dan hubungan industrial.', verified: true, practiceAreas: ['PHK', 'Pesangon', 'Hubungan Industrial'] },
  { name: 'Laras Sekar, S.H., M.H.', role: 'Pengacara Keluarga', specialty: 'Hukum Keluarga', city: 'Semarang', rating: 4.9, reviewCount: 120, experienceYears: 12, casesHandled: 260, pricePerHour: 500000, photoUrl: 'https://i.pravatar.cc/150?img=32', about: 'Berpengalaman dalam perceraian, hak asuh anak, dan waris.', verified: true, practiceAreas: ['Perceraian', 'Hak Asuh Anak', 'Waris'] },
];

// Kata kunci -> spesialisasi, dipakai untuk rekomendasi pengacara dari chat.
export const SPECIALTY_KEYWORDS: Record<string, string[]> = {
  'Penipuan & Penggelapan': ['tipu', 'penipuan', 'gelap', 'investasi bodong', 'kabur'],
  Pencurian: ['curi', 'pencurian', 'maling', 'jambret'],
  Penganiayaan: ['aniaya', 'pukul', 'kekerasan', 'kdrt'],
  'Pencemaran Nama Baik': ['nama baik', 'pencemaran', 'fitnah', 'hina', 'ite'],
  Ketenagakerjaan: ['phk', 'pesangon', 'gaji', 'dipecat', 'kerja'],
  'Hukum Keluarga': ['cerai', 'hak asuh', 'waris', 'nafkah'],
};
