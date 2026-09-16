/* ===========================================================
   La session de révision : constituer la file de cartes, puis
   enregistrer chaque réponse.

   Deux principes du cahier des charges sont ici :
   - MÉLANGE : les cartes dues de tous les paquets sont mélangées.
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

    const retenue = carte => {
      if (carte.statut !== 'active') return false;                       // brouillons et cartes suspendues exclus
      const paquet = this.paquets[carte.paquetId];
      if (!paquet || paquet.archive) return false;
      if (paquetsChoisis && paquetsChoisis.indexOf(carte.paquetId) === -1) return false;
      return true;
    };

    const dues = toutesLesCartes.filter(c => retenue(c) && Planification.estDue(c, jour));

    // Cartes jamais vues, dans la limite du quota quotidien.
    const dejaIntroduitesAujourdHui = toutesLesCartes.filter(
      c => c.etat && c.etat.nbRevisions === 1 && c.etat.dernierJour === jour
    ).length;
    const placesRestantes = Math.max(0, this.reglages.nouvellesParJour - dejaIntroduitesAujourdHui);
    const nouvelles = toutesLesCartes
      .filter(c => retenue(c) && !c.etat)
      .slice(0, placesRestantes);

    const melangees = this.melanger(dues.concat(nouvelles));
    const espacees = this.eviterDeuxFoisLeMemePaquet(melangees);

    this.file = espacees.map(c => ({ carteId: c.id, repetition: false }));
    this.position = 0;
    this.compteur = { vues: 0, reussies: 0, ratees: 0 };
    this.debutCarte = Date.now();
    return { dues: dues.length, nouvelles: nouvelles.length, total: this.file.length };
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
