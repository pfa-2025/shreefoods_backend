import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface SeedItem {
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  alt: string;
  dietary: string[];
  featured?: boolean;
}

// DUMMY CONTENT: names, descriptions and prices are placeholders for development.
// Photos are placeholders served from the frontend (see frontend/public/images/menu/CREDITS.md).
const menu: { name: string; slug: string; items: SeedItem[] }[] = [
  {
    name: 'Appetizers',
    slug: 'appetizers',
    items: [
      { slug: 'vada-pav', name: 'Vada Pav', description: 'Mumbai’s favourite: a spiced potato fritter in a soft pav with garlic chutney and fried green chilli.', priceCents: 700, alt: 'Vada pav with chutney', dietary: ['vegetarian'], featured: true },
      { slug: 'batata-vada', name: 'Batata Vada', description: 'Golden gram-flour fritters filled with mashed potato, mustard seed and curry leaf. Served with green chutney.', priceCents: 600, alt: 'Plate of batata vada', dietary: ['vegetarian', 'vegan'] },
      { slug: 'dhokla', name: 'Khaman Dhokla', description: 'Light, fluffy steamed gram-flour cake tempered with mustard seed, sesame and fresh coriander.', priceCents: 800, alt: 'Yellow dhokla squares', dietary: ['vegetarian', 'vegan'], featured: true },
      { slug: 'khandvi', name: 'Khandvi', description: 'Silky rolls of gram flour and yogurt, finished with coconut, coriander and a mustard-seed tadka.', priceCents: 850, alt: 'Rolled khandvi on a plate', dietary: ['vegetarian'] },
      { slug: 'fafda-jalebi', name: 'Fafda Jalebi', description: 'Crisp gram-flour fafda with papaya chutney, paired with warm, syrupy jalebi. A Gujarati Sunday classic.', priceCents: 900, alt: 'Fafda with jalebi', dietary: ['vegetarian'] },
    ],
  },
  {
    name: 'Main Course',
    slug: 'main-course',
    items: [
      { slug: 'misal-pav', name: 'Misal Pav', description: 'Fiery sprouted-moth curry topped with farsan, onion and lime, served with buttered pav.', priceCents: 1400, alt: 'Bowl of misal pav', dietary: ['vegetarian', 'spicy'], featured: true },
      { slug: 'pav-bhaji', name: 'Pav Bhaji', description: 'Mashed vegetable bhaji simmered in butter and pav bhaji masala, with toasted buttered pav.', priceCents: 1350, alt: 'Pav bhaji with buttered pav', dietary: ['vegetarian'], featured: true },
      { slug: 'undhiyu', name: 'Undhiyu', description: 'Surat’s winter speciality: mixed vegetables and methi muthia slow-cooked in a green masala.', priceCents: 1600, alt: 'Bowl of undhiyu', dietary: ['vegetarian'] },
      { slug: 'thalipeeth', name: 'Thalipeeth', description: 'Multigrain Maharashtrian flatbread, crisp at the edges, served with white butter and curd.', priceCents: 1200, alt: 'Thalipeeth flatbread', dietary: ['vegetarian'] },
      { slug: 'thepla', name: 'Methi Thepla', description: 'Soft fenugreek flatbreads, a Gujarati travel staple, served with pickle and spiced curd.', priceCents: 1100, alt: 'Stack of methi thepla', dietary: ['vegetarian'] },
      { slug: 'sabudana-khichdi', name: 'Sabudana Khichdi', description: 'Tapioca pearls with roasted peanuts, potato and green chilli, finished with lime.', priceCents: 1150, alt: 'Plate of sabudana khichdi', dietary: ['vegetarian', 'gluten-free'] },
    ],
  },
  {
    name: 'Drinks',
    slug: 'drinks',
    items: [
      { slug: 'masala-chai', name: 'Masala Chai', description: 'Strong tea simmered with milk, ginger, cardamom and a hint of black pepper.', priceCents: 400, alt: 'Cup of masala chai', dietary: ['vegetarian'] },
      { slug: 'mango-lassi', name: 'Mango Lassi', description: 'Thick, chilled yogurt blended with ripe mango pulp and a pinch of cardamom.', priceCents: 600, alt: 'Glass of mango lassi', dietary: ['vegetarian', 'gluten-free'], featured: true },
    ],
  },
  {
    name: 'Sweets',
    slug: 'sweets',
    items: [
      { slug: 'puran-poli', name: 'Puran Poli', description: 'Soft flatbread stuffed with sweet chana dal and jaggery, brushed with ghee.', priceCents: 700, alt: 'Puran poli with ghee', dietary: ['vegetarian'], featured: true },
      { slug: 'shrikhand', name: 'Shrikhand', description: 'Strained yogurt whipped with saffron, cardamom and sugar. Served chilled with a puri.', priceCents: 650, alt: 'Bowl of shrikhand', dietary: ['vegetarian', 'gluten-free'] },
      { slug: 'modak', name: 'Modak', description: 'Delicate rice-flour dumplings filled with fresh coconut and jaggery, steamed to order.', priceCents: 750, alt: 'Sweet modak dumplings', dietary: ['vegetarian'] },
      { slug: 'basundi', name: 'Basundi', description: 'Slow-reduced sweetened milk scented with saffron and nutmeg, topped with pistachio.', priceCents: 600, alt: 'Cup of basundi', dietary: ['vegetarian', 'gluten-free'] },
    ],
  },
];

async function main(): Promise<void> {
  for (const [ci, cat] of menu.entries()) {
    const category = await prisma.menuCategory.upsert({
      where: { slug: cat.slug },
      update: { name: cat.name, sortOrder: ci },
      create: { name: cat.name, slug: cat.slug, sortOrder: ci },
    });
    for (const [ii, it] of cat.items.entries()) {
      const publicId = `seed/${it.slug}`;
      const image = await prisma.mediaAsset.upsert({
        where: { publicId },
        update: { url: `/images/menu/${it.slug}.jpg`, altText: it.alt },
        create: { publicId, url: `/images/menu/${it.slug}.jpg`, altText: it.alt, mimeType: 'image/jpeg' },
      });
      const data = {
        name: it.name,
        description: it.description,
        priceCents: it.priceCents,
        categoryId: category.id,
        imageId: image.id,
        dietaryLabels: it.dietary,
        isFeatured: it.featured ?? false,
        sortOrder: ii,
      };
      await prisma.menuItem.upsert({ where: { slug: it.slug }, update: data, create: { slug: it.slug, ...data } });
    }
  }
  // DUMMY restaurant details: replace via the admin (Module 8).
  const settings = {
    restaurantName: 'Shree Foods',
    phone: '(555) 010-2030',
    email: 'hello@shreefoods.example',
    address: '123 Example Street, Edison, NJ 08817',
    openingHours: [
      { day: 'Monday', hours: 'Closed' },
      { day: 'Tuesday – Friday', hours: '11:30 AM – 9:00 PM' },
      { day: 'Saturday – Sunday', hours: '10:00 AM – 10:00 PM' },
    ],
    socialLinks: [
      { label: 'Instagram', url: 'https://www.instagram.com/shreefoods.sv/' },
      { label: 'Facebook', url: 'https://www.facebook.com/rkshah78' },
      { label: 'TikTok', url: 'https://www.tiktok.com/@shreefoods.sv' },
      { label: 'YouTube', url: 'https://www.youtube.com/@ShreeFoods-sv' },
    ],
    taxRateBps: 825, // dummy 8.25% tax
  };
  // DUMMY PayPal QR: encodes an example.com URL, NOT a real account. The admin replaces it in Module 8.
  const qr = await prisma.mediaAsset.upsert({
    where: { publicId: 'seed/payment-qr' },
    update: { url: '/images/payment-qr.png', altText: 'PayPal payment QR code (dummy)' },
    create: { publicId: 'seed/payment-qr', url: '/images/payment-qr.png', altText: 'PayPal payment QR code (dummy)', mimeType: 'image/png' },
  });
  const payment = {
    paymentQrId: qr.id,
    paymentHandle: 'paypal.me/your-handle (dummy)',
    paymentInstructions:
      'Open PayPal, scan the QR code and send the exact total. Then come back here and tap “I’ve paid”. We confirm payment by hand before preparing your order.',
  };
  await prisma.siteSettings.upsert({
    where: { id: 'singleton' },
    update: { ...settings, ...payment },
    create: { id: 'singleton', ...settings, ...payment },
  });

  // DUMMY "What's New" announcements reusing the placeholder food photos.
  const news = [
    { id: 'seed-news-1', slug: 'misal-pav', title: 'Weekend Misal Pav', body: 'Our fiery Kolhapuri-style misal is back every Saturday and Sunday.' },
    { id: 'seed-news-2', slug: 'puran-poli', title: 'Festival Puran Poli', body: 'Handmade puran poli with pure ghee, available for pre-order for festival days.' },
    { id: 'seed-news-3', slug: 'dhokla', title: 'Fresh Dhokla Mornings', body: 'Steamed fresh each morning from 11:30 AM until sold out.' },
    { id: 'seed-news-4', slug: 'mango-lassi', title: 'Mango Lassi Season', body: 'Made with ripe mango pulp. A cool treat for warm afternoons.' },
  ];
  for (const [i, n] of news.entries()) {
    const image = await prisma.mediaAsset.findUniqueOrThrow({ where: { publicId: `seed/${n.slug}` } });
    const data = { title: n.title, body: n.body, imageId: image.id, status: 'PUBLISHED' as const, sortOrder: i, linkUrl: '/menu' };
    await prisma.announcement.upsert({ where: { id: n.id }, update: data, create: { id: n.id, ...data } });
  }
  const count = await prisma.menuItem.count();
  console.log(`Seeded ${menu.length} categories, ${count} menu items`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
