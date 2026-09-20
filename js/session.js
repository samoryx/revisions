/* ===========================================================
   La session de révision : constituer la file de cartes, puis
   enregistrer chaque réponse.

   Trois principes du cahier des charges sont ici :
   - PRIORITÉ : les paquets urgents passent d'abord, puis la section
     Apprendre, puis Comprendre, puis Entretenir.
   - MÉLANGE : à l'intérieur de chaque niveau de priorité, les cartes
     de tous les paquets sont mélangées.
     (Attention : mélanger des matières sans rapport n'apprend rien
     en soi. Le vrai bénéfice vient des cartes qui obligent à
     distinguer deux notions proches — ça se joue à l'écriture des
     cartes, pas ici. Mélanger ne coûte rien, donc on le fait.)
   - RÉAPPRENTISSAGE DANS LA SESSION : une carte ratée revient plus
     loin dans la même session jusqu'à un rappel réussi. Ce second
     passage ne modifie PAS la planification : seule la première
     note de la journée compte pour calculer la date suivante.
   =========================================================== */

const Session = {

  file: [],            // liste de { carteId, repetition }
  position: 0,
  cartes: {},          // identifiant -> carte
  paquets: {},         // identifiant -> paquet
  reglages: null,
  debutCarte: 0,
  compteur: { vues: 0, reussies: 0, ratees: 0 },

  // Nombre de cartes qui passent avant qu'une carte ratée revienne.
  ECART_REPETITION: 5,

  async preparer(paquetsChoisis) {
    this.reglages = await Donnees.reglages();
    const jour = Planification.jourAujourdhui();

    const paquets = await Donnees.tous('paquets');
    this.paquets = {};
    paquets.forEach(p => { this.paquets[p.id] = p; });

    const toutesLesCartes = await Donnees.tous('cartes');
    this.cartes = {};
    toutesLesCartes.forEach(c => { this.cartes[c.id] = c; });

    // Même sélection que celle annoncée sur l'accueil.
    const selection = Planification.selectionDuJour(toutesLesCartes, paquets, this.reglages, jour, paquetsChoisis);

    // On range les cartes par priorité : paquets urgents, puis Apprendre,
    // Comprendre, et Entretenir en dernier. À l'intérieur de chaque groupe,
    // on mélange. Si tu t'arrêtes en cours de route (bus, pause), ce qui
    // presse le plus aura été fait.
    const groupes = {};
    selection.dues.concat(selection.nouvelles).forEach(carte => {
      const priorite = Planification.priorite(this.paquets[carte.paquetId], jour);
      if (!groupes[priorite]) groupes[priorite] = [];
      groupes[priorite].push(carte);
    });
    let ordre = [];
    Object.keys(groupes).map(Number).sort((a, b) => a - b).forEach(priorite => {
      ordre = ordre.concat(this.eviterDeuxFoisLeMemePaquet(this.melanger(groupes[priorite])));
    });

    this.file = ordre.map(c => ({ carteId: c.id, repetition: false }));
    this.position = 0;
    this.compteur = { vues: 0, reussies: 0, ratees: 0 };
    this.debutCarte = Date.now();
    return { dues: selection.dues.length, nouvelles: selection.nouvelles.length, total: this.file.length };
  },

  // Mélange de Fisher-Yates : chaque ordre a la même probabilité.
  melanger(liste) {
    const copie = liste.slice();
    for (let i = copie.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temporaire = copie[i];
      copie[i] = copie[j];
      copie[j] = temporaire;
    }
    return copie;
  },

  // Essaie de ne pas enchaîner deux cartes du même paquet.
  eviterDeuxFoisLeMemePaquet(liste) {
    for (let i = 1; i < liste.length; i++) {
      if (liste[i].paquetId !== liste[i - 1].paquetId) continue;
      for (let j = i + 1; j < liste.length; j++) {
        if (liste[j].paquetId !== liste[i - 1].paquetId) {
          const temporaire = liste[i];
          liste[i] = liste[j];
          liste[j] = temporaire;
          break;
        }
      }
    }
    return liste;
  },

  entreeCourante() {
    return this.position < this.file.length ? this.file[this.position] : null;
  },

  carteCourante() {
    const entree = this.entreeCourante();
    return entree ? this.cartes[entree.carteId] : null;
  },

  paquetCourant() {
    const carte = this.carteCourante();
    return carte ? this.paquets[carte.paquetId] : null;
  },

  terminee() {
    return this.position >= this.file.length;
  },

  restantes() {
    return this.file.length - this.position;
  },

  /* Enregistre une réponse et avance d'une carte. */
  async enregistrer(reponse) {
    const entree = this.entreeCourante();
    const carte = this.cartes[entree.carteId];
    const paquet = this.paquets[carte.paquetId];

    const revision = {
      id: Donnees.nouvelId(),
      carteId: carte.id,
      date: new Date().toISOString(),
      note: reponse.note,                    // 1 Raté, 2 Difficile, 3 Correct, 4 Facile
      confiance: reponse.confiance,          // 1 Aucune idée … 4 Certain
      reponseTapee: reponse.reponseTapee || '',
      elementsCoches: reponse.elementsCoches || [],
      dureeMs: Date.now() - this.debutCarte,
      appareil: this.reglages.nomAppareil,
      planifie: !entree.repetition           // false = simple répétition dans la session
    };
    await Donnees.ecrire('revisions', revision);

    if (revision.planifie) {
      await Planification.rafraichirCarte(carte, paquet, this.reglages);
    }

    this.compteur.vues++;
    if (reponse.note === 1) {
      this.compteur.ratees++;
      // La carte revient plus loin dans la session, jusqu'à un rappel réussi.
      const cible = Math.min(this.position + this.ECART_REPETITION, this.file.length);
      this.file.splice(cible, 0, { carteId: carte.id, repetition: true });
    } else {
      this.compteur.reussies++;
    }

    this.position++;
    this.debutCarte = Date.now();
    return revision;
  }
};
