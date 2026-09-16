/* ===========================================================
   Planification : à partir du JOURNAL des révisions d'une carte,
   on recalcule son état et sa prochaine date.

   Pourquoi recalculer au lieu de simplement mettre à jour ?
   Parce que c'est ce qui rend la fusion PC / téléphone fiable :
   on additionne les deux journaux, on rejoue tout dans l'ordre,
   et on retombe forcément sur le même résultat des deux côtés.

   Règles ajoutées par-dessus FSRS :
   - jamais plus loin que l'échéance du paquet (contrôle, bac…) ;
   - jamais plus loin que le plafond réglable (contrôles surprises) ;
   - petit décalage aléatoire pour éviter que 40 cartes créées le
     même jour reviennent toutes ensemble pour toujours ;
   - une carte est "acquise" après 3 rappels réussis des jours
     différents (critère du réapprentissage successif), pas après un seul.
   =========================================================== */

const Planification = {

  REUSSITES_POUR_ACQUISE: 3,

  // --- Outils de date. Tout est stocké en "AAAA-MM-JJ". ---

  jourAujourdhui: function () {
    const maintenant = new Date();
    // On construit la date locale à la main : toISOString() donnerait
    // l'heure UTC, ce qui décale d'un jour en soirée.
    const mois = String(maintenant.getMonth() + 1).padStart(2, '0');
    const jour = String(maintenant.getDate()).padStart(2, '0');
    return maintenant.getFullYear() + '-' + mois + '-' + jour;
  },

  ajouterJours: function (jour, nombre) {
    const date = new Date(jour + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + nombre);
    return date.toISOString().slice(0, 10);
  },

  differenceEnJours: function (jourDebut, jourFin) {
    const a = Date.parse(jourDebut + 'T00:00:00Z');
    const b = Date.parse(jourFin + 'T00:00:00Z');
    return Math.round((b - a) / 86400000);
  },

  jourLisible: function (jour) {
    const date = new Date(jour + 'T00:00:00Z');
    return date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  },

  /* Décalage aléatoire de ±5 % sur les intervalles d'au moins 3 jours.
     Le hasard est tiré de l'identifiant de la révision : il est donc
     toujours le même si on rejoue le journal (sinon le PC et le
     téléphone calculeraient des dates différentes). */
  appliquerDecalage: function (jours, graine) {
    if (jours < 3) return jours;
    let nombre = 0;
    for (let i = 0; i < graine.length; i++) {
      nombre = (nombre * 31 + graine.charCodeAt(i)) % 100000;
    }
    const fraction = nombre / 100000;            // entre 0 et 1
    const variation = (fraction - 0.5) * 0.1;    // entre -5 % et +5 %
    return Math.max(1, Math.round(jours * (1 + variation)));
  },

  /* Rejoue tout le journal d'une carte et renvoie son état complet. */
  etatDepuisJournal: function (revisions, paquet, reglages) {
    let memoire = null;          // { stabilite, difficulte }
    let dernierJour = null;
    let dueLe = null;
    let dernierIntervalle = 0;
    let echecs = 0;
    let reussitesDeSuite = 0;
    let nbPlanifiees = 0;

    for (let i = 0; i < revisions.length; i++) {
      const revision = revisions[i];

      // Les répétitions à l'intérieur d'une même session ne replanifient rien :
      // elles servent à finir la session sur un rappel réussi, pas à décaler la carte.
      if (revision.planifie === false) continue;

      const jour = revision.date.slice(0, 10);
      const joursEcoules = dernierJour ? this.differenceEnJours(dernierJour, jour) : 0;

      // Deuxième passage planifié le même jour : on ignore, FSRS attend
      // au moins un jour entre deux mesures de mémoire.
      if (memoire && joursEcoules === 0) continue;

      memoire = FSRS.prochainEtat(memoire, joursEcoules, revision.note);
      nbPlanifiees++;

      if (revision.note === 1) {
        echecs++;
        reussitesDeSuite = 0;
      } else {
        reussitesDeSuite++;
      }

      dernierIntervalle = this.calculerIntervalle(memoire.stabilite, jour, paquet, reglages, revision.id);
      dueLe = this.ajouterJours(jour, dernierIntervalle);
      dernierJour = jour;
    }

    if (!memoire) return null;   // carte jamais révisée

    return {
      stabilite: memoire.stabilite,
      difficulte: memoire.difficulte,
      dueLe: dueLe,
      dernierJour: dernierJour,
      dernierIntervalle: dernierIntervalle,
      echecs: echecs,
      reussitesDeSuite: reussitesDeSuite,
      nbRevisions: nbPlanifiees,
      acquise: reussitesDeSuite >= this.REUSSITES_POUR_ACQUISE
    };
  },

  /* Nombre de jours avant la prochaine révision, plafonds compris. */
  calculerIntervalle: function (stabilite, jour, paquet, reglages, graine) {
    const cible = (paquet && paquet.retentionCible) ? paquet.retentionCible : reglages.retentionCible;
    let jours = FSRS.intervalle(stabilite, cible);
    jours = Math.max(1, Math.round(jours));
    jours = Math.min(jours, reglages.intervalleMaxJours);
    // graine absente = simple aperçu affiché sur un bouton : pas de décalage,
    // sinon le nombre annoncé ne serait pas celui qui sera enregistré.
    if (graine) jours = this.appliquerDecalage(jours, graine);

    // Plafond d'échéance : si le paquet a une date (contrôle, bac), on ne
    // saute jamais par-dessus. Une fois l'échéance passée, le plafond ne
    // s'applique plus — c'est à toi de décider si tu continues le paquet.
    if (paquet && paquet.echeance) {
      const restant = this.differenceEnJours(jour, paquet.echeance);
      if (restant > 0) jours = Math.min(jours, restant);
    }
    return Math.max(1, jours);
  },

  /* Simule les 4 notes possibles pour afficher "→ dans X jours" sur les boutons. */
  apercuDesNotes: function (etatActuel, dernierJour, paquet, reglages) {
    const aujourdHui = this.jourAujourdhui();
    const joursEcoules = (etatActuel && dernierJour) ? this.differenceEnJours(dernierJour, aujourdHui) : 0;
    const apercu = {};
    for (let note = 1; note <= 4; note++) {
      const memoire = FSRS.prochainEtat(etatActuel, joursEcoules, note);
      apercu[note] = this.calculerIntervalle(memoire.stabilite, aujourdHui, paquet, reglages, 'apercu');
    }
    return apercu;
  },

  estDue: function (carte, jour) {
    if (!carte.etat) return false;              // jamais vue = "nouvelle", pas "due"
    return carte.etat.dueLe <= jour;
  },

  estSangsue: function (carte, reglages) {
    return !!(carte.etat && carte.etat.echecs >= reglages.seuilSangsue);
  },

  /* Recalcule et enregistre l'état d'une carte à partir du journal. */
  rafraichirCarte: async function (carte, paquet, reglages) {
    const revisions = await Donnees.revisionsDeLaCarte(carte.id);
    carte.etat = this.etatDepuisJournal(revisions, paquet, reglages);
    await Donnees.ecrire('cartes', carte);
    return carte;
  }
};
