/* ===========================================================
   Sauvegarde, restauration, fusion PC / téléphone, import des
   fichiers de cartes.

   Point important sur la fusion : on n'échange pas "l'état des
   cartes" mais le JOURNAL des révisions. Deux journaux s'additionnent
   sans conflit possible (une révision faite dans le bus le mardi et
   une autre sur le PC le mercredi sont deux lignes différentes).
   Après fusion, on rejoue les journaux et tout retombe en ordre.

   Les suppressions voyagent aussi, sous forme d'un registre (voir
   donnees.js) : sans lui, une addition ne peut que rajouter, et ce qui
   a été supprimé d'un côté reviendrait de l'autre.
   =========================================================== */

const Sauvegarde = {

  FORMAT: 'revisions-sauvegarde-v1',

  // ---------- Export ----------

  async construireExport() {
    const reglages = await Donnees.reglages();
    return {
      format: this.FORMAT,
      exporteLe: new Date().toISOString(),
      appareil: reglages.nomAppareil,
      paquets: await Donnees.tous('paquets'),
      cartes: await Donnees.tous('cartes'),
      revisions: await Donnees.tous('revisions'),
      reglages: reglages,
      suppressions: await Donnees.suppressions()
    };
  },

  async exporterFichier() {
    const donnees = await this.construireExport();
    const jour = Planification.jourAujourdhui();
    const nom = 'sauvegarde-' + donnees.appareil.replace(/[^a-zA-Z0-9]/g, '') + '-' + jour + '.json';
    this.telecharger(nom, JSON.stringify(donnees, null, 1));
    await Donnees.majReglages({ derniereSauvegarde: new Date().toISOString() });
    return nom;
  },

  telecharger(nomFichier, texte) {
    const fichier = new Blob([texte], { type: 'application/json' });
    const lien = document.createElement('a');
    lien.href = URL.createObjectURL(fichier);
    lien.download = nomFichier;
    document.body.appendChild(lien);
    lien.click();
    document.body.removeChild(lien);
    setTimeout(function () { URL.revokeObjectURL(lien.href); }, 1000);
  },

  // ---------- Fusion d'une sauvegarde ----------

  async fusionner(donnees) {
    if (!donnees || donnees.format !== this.FORMAT) {
      throw new Error("Ce fichier n'est pas une sauvegarde de l'application.");
    }
    const rapport = { paquets: 0, cartes: 0, revisions: 0, suppressions: 0, reglages: false, recalculees: 0 };

    // 0. Registre des suppressions : on additionne les deux registres.
    //    Tout ce qui y figure est écarté de la suite, et effacé ici à l'étape 5.
    const supprimes = await Donnees.suppressions();
    let registreModifie = false;
    Object.keys(donnees.suppressions || {}).forEach(function (id) {
      if (!supprimes[id]) {
        supprimes[id] = donnees.suppressions[id];
        registreModifie = true;
      }
    });
    if (registreModifie) await Donnees.ecrireSuppressions(supprimes);

    // Les paquets dont il faudra recalculer les cartes.
    const aRecalculer = {};

    // 1. Paquets : on garde la version modifiée le plus récemment.
    const paquetsLocaux = {};
    (await Donnees.tous('paquets')).forEach(function (p) { paquetsLocaux[p.id] = p; });
    const paquetsAEcrire = [];
    (donnees.paquets || []).forEach(function (paquet) {
      if (supprimes[paquet.id]) return;
      const local = paquetsLocaux[paquet.id];
      if (!local || (paquet.modifieLe || '') > (local.modifieLe || '')) {
        paquetsAEcrire.push(paquet);
        paquetsLocaux[paquet.id] = paquet;
        // Section, échéance, rétention ou remise à zéro ont pu changer :
        // les dates de toutes ses cartes en dépendent.
        aRecalculer[paquet.id] = true;
        rapport.paquets++;
      }
    });
    await Donnees.ecrirePlusieurs('paquets', paquetsAEcrire);

    // 2. Cartes : même règle.
    const cartesLocales = {};
    (await Donnees.tous('cartes')).forEach(function (c) { cartesLocales[c.id] = c; });
    const cartesAEcrire = [];
    (donnees.cartes || []).forEach(function (carte) {
      if (supprimes[carte.id]) return;
      const locale = cartesLocales[carte.id];
      if (!locale || (carte.modifieLe || '') > (locale.modifieLe || '')) {
        cartesAEcrire.push(carte);
        cartesLocales[carte.id] = carte;
        aRecalculer[carte.paquetId] = true;
        rapport.cartes++;
      }
    });
    await Donnees.ecrirePlusieurs('cartes', cartesAEcrire);

    // 3. Révisions : on ajoute simplement celles qu'on n'a pas.
    const connues = {};
    (await Donnees.tous('revisions')).forEach(function (r) { connues[r.id] = true; });
    const revisionsAEcrire = [];
    (donnees.revisions || []).forEach(function (revision) {
      if (connues[revision.id] || supprimes[revision.carteId]) return;
      revisionsAEcrire.push(revision);
      const carte = cartesLocales[revision.carteId];
      if (carte) aRecalculer[carte.paquetId] = true;
      rapport.revisions++;
    });
    await Donnees.ecrirePlusieurs('revisions', revisionsAEcrire);

    // 4. Réglages partagés : on garde ceux modifiés le plus récemment.
    //    Le nom de l'appareil, lui, ne voyage pas.
    let reglages = await Donnees.reglages();
    const recus = donnees.reglages;
    if (recus && recus.modifieLe && recus.modifieLe > (reglages.modifieLe || '')) {
      const modifications = { modifieLe: recus.modifieLe };
      Donnees.REGLAGES_PARTAGES.forEach(function (champ) {
        if (recus[champ] !== undefined) modifications[champ] = recus[champ];
      });
      reglages = await Donnees.majReglages(modifications);
      rapport.reglages = true;
    }

    // 5. On efface ici ce que l'autre appareil a supprimé.
    rapport.suppressions = await Donnees.appliquerSuppressions(supprimes);

    // 6. On rejoue le journal des cartes concernées. Si les réglages ont
    //    changé (rétention, plafond, seuil), toutes les cartes le sont.
    rapport.recalculees = await Planification.rafraichirTout(reglages, rapport.reglages ? null : aRecalculer);
    return rapport;
  },

  // ---------- Import d'un fichier de cartes ----------

  // « cartes-v2 » (v18) : un fichier qui place, modifie ou supprime. Une app
  // plus ancienne le refuse, au lieu de le lire de travers et de créer des doublons.
  FORMATS_CARTES: ['cartes-v1', 'cartes-v2'],

  /* Format attendu (voir FORMAT-DES-CARTES.md) :
     { "format": "cartes-v1",
       "paquet": { "nom": "...", "matiere": "...", "echeance": "2026-10-03", "cours": [...] },
       "cartes": [ { "type": "rappel", "question": "...", "elementsCles": [...],
                     "reponse": "...", "exemples": [...], "source": "photo 2" } ] }
     En plus, avec le format « cartes-v2 » :
     - « avant » sur une carte ou une partie de cours : la placer juste avant
       la carte (question exacte) ou la partie (titre exact) indiquée ;
     - « remplace » sur une carte ou une partie : modifier celle qui porte cette
       question ou ce titre. Une carte modifiée garde son historique et repasse
       en brouillon : tu la relis avant qu'elle revienne en révision ;
     - « supprimer » : { "cartes": [questions], "cours": [titres] }. Rien n'est
       écrit tant que confirmerSuppressions() n'a pas répondu oui.
     Un repère introuvable n'arrête pas l'import : il est signalé dans le rapport. */
  async importerCartes(donnees, confirmerSuppressions) {
    if (!donnees || this.FORMATS_CARTES.indexOf(donnees.format) === -1 || !Array.isArray(donnees.cartes)) {
      throw new Error("Ce fichier n'est pas un fichier de cartes (format \"cartes-v1\" ou \"cartes-v2\" attendu).");
    }
    const maintenant = new Date().toISOString();
    const signalements = [];
    const texte = function (valeur) { return String(valeur === undefined || valeur === null ? '' : valeur).trim(); };

    // On retrouve le paquet par son nom, sinon on le crée.
    const paquets = await Donnees.tous('paquets');
    const nomVoulu = (donnees.paquet && donnees.paquet.nom) ? donnees.paquet.nom : 'Sans nom';
    let paquet = paquets.find(function (p) { return p.nom === nomVoulu; });
    let paquetCree = false;
    // Un fichier sans carte ne contient qu'un cours : il complète un paquet
    // existant. S'il ne le trouve pas (paquet renommé, faute de frappe), on
    // refuse plutôt que de créer un paquet vide qui ne servirait à rien.
    if (!paquet && donnees.cartes.length === 0) {
      throw new Error('Ce fichier ne contient qu\'un cours, à ajouter au paquet « ' + nomVoulu +
        ' ». Aucun paquet ne porte exactement ce nom dans l\'app. Si tu l\'as renommé, remets-lui ce nom le temps de l\'import, ou signale-le à Claude.');
    }

    // Les cartes déjà dans le paquet, retrouvées par leur question.
    const existantes = paquet ? (await Donnees.tous('cartes')).filter(function (c) { return c.paquetId === paquet.id; }) : [];
    const parQuestion = {};
    existantes.forEach(function (c) { parQuestion[c.question.trim()] = c; });
    const coursActuel = paquet && Array.isArray(paquet.cours) ? paquet.cours.slice() : [];

    // 1. Suppressions : on les cherche, puis on demande ton accord AVANT
    //    d'écrire quoi que ce soit. Sans ton accord, rien n'est importé.
    const demande = donnees.supprimer || {};
    const cartesASupprimer = [];
    (Array.isArray(demande.cartes) ? demande.cartes : []).forEach(function (q) {
      const carte = parQuestion[texte(q)];
      if (!carte) signalements.push('Carte à supprimer introuvable : « ' + texte(q) + ' ».');
      else if (cartesASupprimer.indexOf(carte) === -1) cartesASupprimer.push(carte);
    });
    const partiesASupprimer = [];
    (Array.isArray(demande.cours) ? demande.cours : []).forEach(function (t) {
      const titre = texte(t);
      if (!coursActuel.some(function (p) { return p.titre === titre; })) signalements.push('Partie de cours à supprimer introuvable : « ' + titre + ' ».');
      else if (partiesASupprimer.indexOf(titre) === -1) partiesASupprimer.push(titre);
    });
    if (cartesASupprimer.length + partiesASupprimer.length > 0) {
      const accord = typeof confirmerSuppressions === 'function' && await confirmerSuppressions({
        cartes: cartesASupprimer.map(function (c) { return c.question; }),
        cours: partiesASupprimer
      });
      if (!accord) throw new Error('Import annulé : rien n\'a été modifié.');
    }
    cartesASupprimer.forEach(function (c) { delete parQuestion[c.question.trim()]; });

    if (!paquet) {
      const echeance = (donnees.paquet && donnees.paquet.echeance) || null;
      const sectionFichier = donnees.paquet && donnees.paquet.section;
      paquet = {
        id: Donnees.nouvelId(),
        nom: nomVoulu,
        matiere: (donnees.paquet && donnees.paquet.matiere) || '',
        echeance: echeance,
        // Section demandée par le fichier, sinon : Apprendre s'il y a une date, Comprendre sinon.
        section: Planification.SECTIONS[sectionFichier] ? sectionFichier : (echeance ? 'apprendre' : 'comprendre'),
        retentionEntretien: Planification.RETENTION_ENTRETIEN_DEFAUT,
        retentionCible: null,
        archive: false,
        creeLe: maintenant,
        sectionDepuis: maintenant,
        modifieLe: maintenant
      };
      await Donnees.ecrire('paquets', paquet);
      paquetCree = true;
    } else if (donnees.paquet && donnees.paquet.echeance && !paquet.echeance) {
      paquet.echeance = donnees.paquet.echeance;
      paquet.modifieLe = maintenant;
      await Donnees.ecrire('paquets', paquet);
    }

    // 2. Le cours du chapitre s'enrichit au fil des imports : une partie de même
    //    titre est remplacée (correction), une nouvelle partie est ajoutée à la
    //    fin — sauf si le fichier dit où la mettre (« avant »).
    const coursRecu = this.coursPropre(donnees.paquet && donnees.paquet.cours);
    const bilanCours = { ajoutees: 0, remplacees: 0, renommees: 0, deplacees: 0, supprimees: 0 };
    if (coursRecu.length > 0 || partiesASupprimer.length > 0) {
      const cours = coursActuel.filter(function (p) { return partiesASupprimer.indexOf(p.titre) === -1; });
      bilanCours.supprimees = partiesASupprimer.length;
      const indexDe = function (titre) { return cours.findIndex(function (p) { return p.titre === titre; }); };
      coursRecu.forEach(function (recu) {
        const partie = recu.partie;
        const position = indexDe(recu.remplace || partie.titre);
        if (recu.remplace && position === -1) {
          signalements.push('Partie à remplacer introuvable : « ' + recu.remplace + ' ». Rien n\'a été changé pour elle.');
          return;
        }
        if (recu.remplace && partie.titre !== recu.remplace && indexDe(partie.titre) !== -1) {
          signalements.push('Impossible de renommer « ' + recu.remplace + ' » : une partie s\'appelle déjà « ' + partie.titre + ' ».');
          return;
        }
        if (position === -1) {
          // Nouvelle partie : à la place demandée, sinon à la fin.
          const cible = recu.avant ? indexDe(recu.avant) : -1;
          if (cible === -1) {
            cours.push(partie);
            if (recu.avant) signalements.push('Repère « ' + recu.avant + ' » introuvable : la partie « ' + partie.titre + ' » est ajoutée à la fin.');
          } else {
            cours.splice(cible, 0, partie);
          }
          bilanCours.ajoutees++;
          return;
        }
        // Partie existante : contenu (et titre) remplacés, puis déplacement éventuel.
        cours[position] = partie;
        bilanCours.remplacees++;
        if (recu.remplace && partie.titre !== recu.remplace) bilanCours.renommees++;
        if (recu.avant) {
          cours.splice(position, 1);
          const cible = indexDe(recu.avant);
          if (cible === -1) {
            cours.splice(position, 0, partie);
            signalements.push('Repère « ' + recu.avant + ' » introuvable : la partie « ' + partie.titre + ' » reste à sa place.');
          } else {
            cours.splice(cible, 0, partie);
            bilanCours.deplacees++;
          }
        }
      });
      paquet.cours = cours;
      paquet.modifieLe = maintenant;
      await Donnees.ecrire('paquets', paquet);
    }

    // 3. Les cartes. Même question qu'une carte du paquet = carte déjà là :
    //    pas de doublon si le même fichier est importé deux fois.

    // Un marquage n'est enregistré que s'il est vraiment dans le fichier
    // (true ou false). Absent = on ne décide rien, la carte reste en jeu.
    const marquage = function (valeur) { return typeof valeur === 'boolean' ? valeur : undefined; };

    const nouvelles = [];
    const modifiees = {};             // cartes déjà là, à réécrire : { id: carte }
    const placements = [];            // { carte, avant }
    const dansCeFichier = {};
    const bilanCartes = { ignorees: 0, misesAJour: 0, remplacees: 0, placees: 0 };
    donnees.cartes.forEach(function (source, position) {
      const question = texte(source.question);
      if (!question) return;
      const avant = texte(source.avant);
      const remplace = texte(source.remplace);

      if (remplace) {
        // Modifier une carte déjà là, retrouvée par sa question actuelle.
        const cible = parQuestion[remplace];
        if (!cible) {
          signalements.push('Carte à remplacer introuvable : « ' + remplace + ' ». Rien n\'a été changé pour elle.');
          return;
        }
        if (question !== remplace && parQuestion[question]) {
          signalements.push('Impossible de remplacer « ' + remplace + ' » : la question « ' + question + ' » existe déjà dans ce paquet.');
          return;
        }
        delete parQuestion[remplace];
        Object.assign(cible, {
          type: source.type === 'explique' ? 'explique' : 'rappel',
          question: question,
          elementsCles: Array.isArray(source.elementsCles) ? source.elementsCles.filter(Boolean) : [],
          reponse: String(source.reponse || ''),
          exemples: Array.isArray(source.exemples) ? source.exemples.filter(Boolean) : [],
          surPapier: !!source.surPapier,
          source: source.source || '',
          modifieLe: maintenant
        });
        if (marquage(source.comprendre) !== undefined) cible.comprendre = source.comprendre;
        if (marquage(source.essentiel) !== undefined) cible.essentiel = source.essentiel;
        // Son historique est gardé ; tu la relis avant qu'elle revienne en révision.
        if (cible.statut === 'active') cible.statut = 'brouillon';
        parQuestion[question] = cible;
        modifiees[cible.id] = cible;
        bilanCartes.remplacees++;
        if (avant) placements.push({ carte: cible, avant: avant });
        return;
      }

      if (dansCeFichier[question]) { bilanCartes.ignorees++; return; }   // doublon à l'intérieur du fichier
      const dejaLa = parQuestion[question];
      if (dejaLa) {
        // Carte déjà importée : on ne touche ni à son contenu (tu as pu le
        // corriger) ni à son historique. On complète seulement les marquages
        // qui lui manquent — c'est ce qui permet de marquer après coup des
        // cartes importées avant l'existence des sections. Renvoyée avec
        // « avant », elle est déplacée.
        let modifiee = false;
        ['comprendre', 'essentiel'].forEach(function (champ) {
          if (dejaLa[champ] === undefined && marquage(source[champ]) !== undefined) {
            dejaLa[champ] = source[champ];
            modifiee = true;
          }
        });
        if (modifiee) { dejaLa.modifieLe = maintenant; modifiees[dejaLa.id] = dejaLa; bilanCartes.misesAJour++; }
        else if (!avant) bilanCartes.ignorees++;
        if (avant) placements.push({ carte: dejaLa, avant: avant });
        return;
      }

      dansCeFichier[question] = true;
      const nouvelle = {
        id: Donnees.nouvelId(),
        paquetId: paquet.id,
        type: source.type === 'explique' ? 'explique' : 'rappel',
        question: question,
        elementsCles: Array.isArray(source.elementsCles) ? source.elementsCles.filter(Boolean) : [],
        reponse: String(source.reponse || ''),
        exemples: Array.isArray(source.exemples) ? source.exemples.filter(Boolean) : [],
        maFormulation: '',
        surPapier: !!source.surPapier,
        comprendre: marquage(source.comprendre),   // en jeu dès la section Comprendre ?
        essentiel: marquage(source.essentiel),     // gardée en section Entretenir ?
        source: source.source || '',
        statut: 'brouillon',          // à valider avant d'entrer en révision
        etat: null,
        ordre: position,              // pour introduire les cartes dans l'ordre du cours
        creeLe: maintenant,
        modifieLe: maintenant
      };
      nouvelles.push(nouvelle);
      parQuestion[question] = nouvelle;
      if (avant) placements.push({ carte: nouvelle, avant: avant });
    });

    // 4. Placements. Chaque carte du paquet reçoit un rang (sa place dans
    //    l'ordre du cours, de 1000 en 1000), puis une carte placée prend un rang
    //    entre celui de la carte qui précède le repère et celui du repère.
    if (placements.length > 0) {
      const supprimees = {};
      cartesASupprimer.forEach(function (c) { supprimees[c.id] = true; });
      const toutes = existantes.filter(function (c) { return !supprimees[c.id]; }).concat(nouvelles);
      const noter = function (carte) {
        if (existantes.indexOf(carte) !== -1) { carte.modifieLe = maintenant; modifiees[carte.id] = carte; }
      };
      const renumeroter = function () {
        toutes.slice().sort(Planification.ordreDuCours).forEach(function (carte, i) {
          const rang = (i + 1) * 1000;
          if (carte.rang !== rang) { carte.rang = rang; noter(carte); }
        });
      };
      if (toutes.some(function (c) { return typeof c.rang !== 'number'; })) renumeroter();
      placements.forEach(function (p) {
        const repere = parQuestion[p.avant];
        if (!repere || repere === p.carte) {
          signalements.push('Repère « ' + p.avant + ' » introuvable : la carte « ' + p.carte.question + ' » garde sa place.');
          return;
        }
        const rangAvantLeRepere = function () {
          const ordre = toutes.filter(function (c) { return c !== p.carte; }).sort(Planification.ordreDuCours);
          const i = ordre.indexOf(repere);
          return i > 0 ? ordre[i - 1].rang : repere.rang - 1000;
        };
        let precedent = rangAvantLeRepere();
        if (repere.rang - precedent < 1e-6) { renumeroter(); precedent = rangAvantLeRepere(); }
        p.carte.rang = (precedent + repere.rang) / 2;
        noter(p.carte);
        bilanCartes.placees++;
      });
    }

    await Donnees.ecrirePlusieurs('cartes', nouvelles.concat(Object.keys(modifiees).map(function (id) { return modifiees[id]; })));
    if (cartesASupprimer.length > 0) await Donnees.supprimerCartes(cartesASupprimer.map(function (c) { return c.id; }));
    return {
      paquet: paquet, paquetCree: paquetCree,
      ajoutees: nouvelles.length, misesAJour: bilanCartes.misesAJour, ignorees: bilanCartes.ignorees,
      cartesRemplacees: bilanCartes.remplacees, cartesPlacees: bilanCartes.placees, cartesSupprimees: cartesASupprimer.length,
      coursAjoutees: bilanCours.ajoutees, coursRemplacees: bilanCours.remplacees, coursRenommees: bilanCours.renommees,
      coursDeplacees: bilanCours.deplacees, coursSupprimees: bilanCours.supprimees,
      signalements: signalements
    };
  },

  /* Ne garde du cours reçu que des parties bien formées, avec à part les
     consignes « avant » (où la placer) et « remplace » (quelle partie modifier).
     origine : "cours" = tiré de tes photos ; "complement" = ajouté par Claude. */
  coursPropre(cours) {
    if (!Array.isArray(cours)) return [];
    return cours
      .filter(p => p && String(p.titre || '').trim() && String(p.texte || '').trim())
      .map(p => ({
        partie: {
          titre: String(p.titre).trim(),
          texte: String(p.texte),
          origine: p.origine === 'complement' ? 'complement' : 'cours',
          source: String(p.source || '')
        },
        avant: String(p.avant || '').trim(),
        remplace: String(p.remplace || '').trim()
      }));
  },

  // ---------- Lecture d'un fichier choisi par l'utilisateur ----------

  lireFichier(fichier) {
    return new Promise(function (resoudre, rejeter) {
      const lecteur = new FileReader();
      lecteur.onload = function () {
        try { resoudre(JSON.parse(lecteur.result)); }
        catch (erreur) { rejeter(new Error('Fichier illisible : ' + erreur.message)); }
      };
      lecteur.onerror = function () { rejeter(lecteur.error); };
      lecteur.readAsText(fichier);
    });
  }
};
