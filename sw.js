/* ===========================================================
   "Service worker" : le petit programme qui garde une copie de
   l'application dans le navigateur. C'est lui qui permet d'ouvrir
   l'app dans le bus, sans connexion.

   Il ne touche JAMAIS à tes données (elles sont dans IndexedDB) :
   il ne met en cache que les fichiers de l'app.

   Quand je modifie l'app, je change le numéro de VERSION ci-dessous :
   le navigateur remplace alors l'ancienne copie.
   =========================================================== */

const VERSION = 'revisions-v8';   // v8 : bouton « Tester la connexion »

const FICHIERS = [
  './',
  './index.html',
  './style.css',
  './js/fsrs.js',
  './js/donnees.js',
  './js/planification.js',
  './js/sauvegarde.js',
  './js/synchro.js',
  './js/session.js',
  './js/app.js',
  './manifest.webmanifest',
  './icones/icone-192.png',
  './icones/icone-512.png'
];

self.addEventListener('install', evenement => {
  evenement.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(FICHIERS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', evenement => {
  // On supprime les copies des versions précédentes.
  evenement.waitUntil(
    caches.keys()
      .then(noms => Promise.all(noms.filter(nom => nom !== VERSION).map(nom => caches.delete(nom))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', evenement => {
  if (evenement.request.method !== 'GET') return;
  evenement.respondWith(
    caches.match(evenement.request).then(copie => {
      // Copie locale d'abord (donc instantané et hors ligne),
      // et on ne va sur le réseau que si le fichier n'est pas en cache.
      return copie || fetch(evenement.request);
    })
  );
});
