/* ===========================================================
   Stockage local (IndexedDB).

   IndexedDB est la base de données intégrée au navigateur. Tout
   reste sur l'appareil : rien n'est envoyé nulle part.

   Quatre "magasins" (l'équivalent de quatre tableaux) :
   - paquets   : un paquet = un chapitre / une matière / un thème
   - cartes    : les flashcards, avec leur état FSRS en cache
   - revisions : le JOURNAL, une ligne par réponse donnée. Il ne
                 s'efface jamais : c'est lui la vraie mémoire de
                 l'app, l'état des cartes en est recalculé.
   - reglages  : l'objet de configuration, et le REGISTRE DES
                 SUPPRESSIONS (voir plus bas)
   =========================================================== */

const Donnees = (function () {

  const NOM_BASE = 'revisions';
  const VERSION_BASE = 1;
  let base = null;

  const REGLAGES_PAR_DEFAUT = {
    id: 'reglages',
    nouvellesParJour: 10,       // combien de cartes jamais vues par jour au maximum
    retentionCible: 0.9,        // 0,9 = on accepte d'oublier 1 carte sur 10 au moment de la révision
    intervalleMaxJours: 60,     // plafond : utile tant qu'il peut y avoir des contrôles surprises
    seuilSangsue: 6,            // à partir de X échecs, la carte est signalée (« elle résiste »)
    nomAppareil: 'PC',
    derniereSauvegarde: null
  };

  // Les réglages qui voyagent avec la synchronisation. Le nom de l'appareil
  // n'en fait pas partie : chaque appareil garde le sien.
  const REGLAGES_PARTAGES = ['nouvellesParJour', 'retentionCible', 'intervalleMaxJours', 'seuilSangsue'];

  function ouvrir() {
    if (base) return Promise.resolve(base);
    return new Promise(function (resoudre, rejeter) {
      const demande = indexedDB.open(NOM_BASE, VERSION_BASE);

      // Ne s'exécute qu'à la toute première ouverture (ou à un changement de version).
      demande.onupgradeneeded = function (evenement) {
        const b = evenement.target.result;
        if (!b.objectStoreNames.contains('paquets')) {
          b.createObjectStore('paquets', { keyPath: 'id' });
        }
        if (!b.objectStoreNames.contains('cartes')) {
          const cartes = b.createObjectStore('cartes', { keyPath: 'id' });
          cartes.createIndex('paquetId', 'paquetId', { unique: false });
        }
        if (!b.objectStoreNames.contains('revisions')) {
          const revisions = b.createObjectStore('revisions', { keyPath: 'id' });
          revisions.createIndex('carteId', 'carteId', { unique: false });
        }
        if (!b.objectStoreNames.contains('reglages')) {
          b.createObjectStore('reglages', { keyPath: 'id' });
        }
      };

      demande.onsuccess = function () { base = demande.result; resoudre(base); };
      demande.onerror = function () { rejeter(demande.error); };
    });
  }

  // Transforme une DEMANDE de lecture/écriture en promesse.
  function enPromesse(demande) {
    return new Promise(function (resoudre, rejeter) {
      demande.onsuccess = function () { resoudre(demande.result); };
      demande.onerror = function () { rejeter(demande.error); };
    });
  }

  /* Transforme une TRANSACTION en promesse. Attention : une transaction
     ne signale pas sa fin par "onsuccess" (ça, c'est une demande) mais
     par "oncomplete". Confondre les deux bloque l'application. */
  function transactionTerminee(transaction) {
    return new Promise(function (resoudre, rejeter) {
      transaction.oncomplete = function () { resoudre(); };
      transaction.onerror = function () { rejeter(transaction.error); };
      transaction.onabort = function () { rejeter(transaction.error); };
    });
  }

  async function tous(magasin) {
    const b = await ouvrir();
    return enPromesse(b.transaction(magasin, 'readonly').objectStore(magasin).getAll());
  }

  async function lire(magasin, id) {
    const b = await ouvrir();
    return enPromesse(b.transaction(magasin, 'readonly').objectStore(magasin).get(id));
  }

  async function ecrire(magasin, objet) {
    const b = await ouvrir();
    const transaction = b.transaction(magasin, 'readwrite');
    transaction.objectStore(magasin).put(objet);
    await transactionTerminee(transaction);
    return objet;
  }

  async function ecrirePlusieurs(magasin, objets) {
    if (objets.length === 0) return;
    const b = await ouvrir();
    const transaction = b.transaction(magasin, 'readwrite');
    const m = transaction.objectStore(magasin);
    objets.forEach(function (o) { m.put(o); });
    return transactionTerminee(transaction);
  }

  async function supprimer(magasin, id) {
    const b = await ouvrir();
    const transaction = b.transaction(magasin, 'readwrite');
    transaction.objectStore(magasin).delete(id);
    return transactionTerminee(transaction);
  }

  // Toutes les révisions d'une carte, triées de la plus ancienne à la plus récente.
  async function revisionsDeLaCarte(carteId) {
    const b = await ouvrir();
    const index = b.transaction('revisions', 'readonly').objectStore('revisions').index('carteId');
    const liste = await enPromesse(index.getAll(carteId));
    liste.sort(function (a, b2) { return a.date < b2.date ? -1 : 1; });
    return liste;
  }

  async function reglages() {
    const enregistres = await lire('reglages', 'reglages');
    // Object.assign complète les réglages manquants par les valeurs par défaut
    // (utile si j'ajoute un réglage plus tard).
    return Object.assign({}, REGLAGES_PAR_DEFAUT, enregistres || {});
  }

  async function majReglages(modifications) {
    const actuels = await reglages();
    return ecrire('reglages', Object.assign(actuels, modifications));
  }

  /* ---------- Registre des suppressions ----------

     Sans lui, la synchronisation ferait revenir tout ce que tu supprimes :
     elle additionne les données des deux appareils, et un paquet absent
     d'un côté ressemble à un paquet « nouveau », pas à un paquet supprimé.
     On note donc chaque suppression : { identifiant: { magasin, supprimeLe } }.
     Le registre voyage avec la synchronisation ; une fois noté, un élément
     ne revient plus jamais, sur aucun appareil.

     Il est rangé dans le magasin des réglages, sous l'identifiant
     « suppressions » : ça évite de changer la structure de la base. */

  async function suppressions() {
    const enregistre = await lire('reglages', 'suppressions');
    return (enregistre && enregistre.liste) || {};
  }

  async function ecrireSuppressions(liste) {
    return ecrire('reglages', { id: 'suppressions', liste: liste });
  }

  /* Efface pour de bon, ici, tout ce que le registre désigne : paquets,
     cartes, et les révisions des cartes effacées. Renvoie le nombre
     d'éléments effacés. */
  async function appliquerSuppressions(liste) {
    let effaces = 0;
    const identifiant = function (o) { return o.id; };
    for (const magasin of ['paquets', 'cartes']) {
      const ids = (await tous(magasin)).filter(function (o) { return liste[o.id]; }).map(identifiant);
      await supprimerPlusieurs(magasin, ids);
      effaces += ids.length;
    }
    const revisions = (await tous('revisions')).filter(function (r) { return liste[r.carteId]; }).map(identifiant);
    await supprimerPlusieurs('revisions', revisions);
    return effaces;
  }

  async function supprimerPlusieurs(magasin, ids) {
    if (ids.length === 0) return;
    const b = await ouvrir();
    const transaction = b.transaction(magasin, 'readwrite');
    const m = transaction.objectStore(magasin);
    ids.forEach(function (id) { m.delete(id); });
    return transactionTerminee(transaction);
  }

  /* Supprime des cartes (et leurs révisions), en le notant au registre. */
  async function supprimerCartes(ids) {
    const liste = await suppressions();
    const maintenant = new Date().toISOString();
    ids.forEach(function (id) { liste[id] = { magasin: 'cartes', supprimeLe: maintenant }; });
    await ecrireSuppressions(liste);
    await appliquerSuppressions(liste);
  }

  /* Supprime un paquet, toutes ses cartes et leurs révisions, en le notant au registre. */
  async function supprimerPaquet(paquetId) {
    const liste = await suppressions();
    const maintenant = new Date().toISOString();
    liste[paquetId] = { magasin: 'paquets', supprimeLe: maintenant };
    (await tous('cartes')).forEach(function (c) {
      if (c.paquetId === paquetId) liste[c.id] = { magasin: 'cartes', supprimeLe: maintenant };
    });
    await ecrireSuppressions(liste);
    await appliquerSuppressions(liste);
  }

  function nouvelId() {
    // crypto.randomUUID donne un identifiant unique, indispensable pour que
    // les données du PC et celles du téléphone puissent fusionner sans collision.
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  return {
    ouvrir: ouvrir,
    tous: tous,
    lire: lire,
    ecrire: ecrire,
    ecrirePlusieurs: ecrirePlusieurs,
    supprimer: supprimer,
    revisionsDeLaCarte: revisionsDeLaCarte,
    reglages: reglages,
    majReglages: majReglages,
    suppressions: suppressions,
    ecrireSuppressions: ecrireSuppressions,
    appliquerSuppressions: appliquerSuppressions,
    supprimerCartes: supprimerCartes,
    supprimerPaquet: supprimerPaquet,
    nouvelId: nouvelId,
    REGLAGES_PAR_DEFAUT: REGLAGES_PAR_DEFAUT,
    REGLAGES_PARTAGES: REGLAGES_PARTAGES
  };
})();
