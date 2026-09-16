/* ===========================================================
   FSRS-6 — l'algorithme qui décide QUAND revoir une carte.

   Idée générale : chaque carte a deux nombres.
   - la STABILITÉ (S) = le nombre de jours au bout duquel il te reste
     90 % de chances de retrouver la réponse. Elle grandit à chaque
     rappel réussi, elle chute à chaque échec.
   - la DIFFICULTÉ (D), entre 1 et 10 = à quel point cette carte
     résiste. Elle monte quand tu rates, elle descend quand c'est facile.

   Les formules et les 21 paramètres viennent de la bibliothèque de
   référence ts-fsrs (projet open-spaced-repetition, licence MIT).
   Je ne les ai pas inventées : elles ont été entraînées sur des
   millions de révisions réelles. Les valeurs ci-dessous sont les
   valeurs par défaut, valables pour quelqu'un dont on ne connaît
   pas encore l'historique — c'est ton cas au départ.
   =========================================================== */

const FSRS = (function () {

  // Les 21 paramètres. Les 4 premiers = stabilité de départ selon la
  // note donnée au tout premier passage (Raté, Difficile, Correct, Facile).
  const W = [
    0.212, 1.2931, 2.3065, 8.2956,
    6.4133, 0.8334, 3.0194, 0.001,
    1.8722, 0.1666, 0.796, 1.4835,
    0.0614, 0.2629, 1.6483, 0.6014,
    1.8729, 0.5425, 0.0912, 0.0658,
    0.1542
  ];

  // Forme de la courbe d'oubli. DECAY vient du dernier paramètre.
  const DECAY = -W[20];
  const FACTEUR = Math.exp(Math.log(0.9) / DECAY) - 1;

  // Bornes de sécurité : une stabilité ne descend jamais à zéro.
  const S_MIN = 0.001;
  const S_MAX = 36500;

  function borner(valeur, mini, maxi) {
    return Math.min(Math.max(valeur, mini), maxi);
  }

  /* Probabilité de retrouver la réponse "jours" jours après la dernière
     révision, pour une carte de stabilité donnée. Vaut 0,9 quand
     jours = stabilité, par construction. */
  function retrouvabilite(jours, stabilite) {
    return Math.pow(1 + FACTEUR * jours / stabilite, DECAY);
  }

  /* Combien de jours attendre pour que la probabilité de rappel tombe
     pile sur la rétention visée (0,9 par défaut). C'est l'inverse de
     la fonction précédente. */
  function intervalle(stabilite, retentionCible) {
    const modificateur = (Math.pow(retentionCible, 1 / DECAY) - 1) / FACTEUR;
    return stabilite * modificateur;
  }

  // --- Premier passage sur une carte ---

  function stabiliteInitiale(note) {
    return Math.max(W[note - 1], 0.1);
  }

  function difficulteInitiale(note) {
    return borner(W[4] - Math.exp((note - 1) * W[5]) + 1, 1, 10);
  }

  // --- Passages suivants ---

  function prochaineDifficulte(difficulte, note) {
    // Une note "Facile" (4) fait baisser la difficulté, "Raté" (1) la fait monter.
    const variation = -W[6] * (note - 3);
    // Amortissement : plus la carte est déjà difficile, moins elle bouge.
    const amortie = difficulte + variation * (10 - difficulte) / 9;
    // Puis on ramène doucement vers la difficulté d'une carte facile,
    // pour qu'une carte ne reste pas coincée à 10 pour toujours.
    return borner(W[7] * difficulteInitiale(4) + (1 - W[7]) * amortie, 1, 10);
  }

  function stabiliteApresReussite(difficulte, stabilite, retrouvabilite_, note) {
    const penaliteDifficile = (note === 2) ? W[15] : 1;
    const bonusFacile = (note === 4) ? W[16] : 1;
    // Point clé : plus tu attends avant de réviser (retrouvabilité basse),
    // plus le rappel réussi augmente la stabilité. Réviser trop tôt ne sert
    // presque à rien — c'est tout l'intérêt de l'espacement.
    const nouvelle = stabilite * (1 +
      Math.exp(W[8]) *
      (11 - difficulte) *
      Math.pow(stabilite, -W[9]) *
      (Math.exp((1 - retrouvabilite_) * W[10]) - 1) *
      penaliteDifficile *
      bonusFacile);
    return borner(nouvelle, S_MIN, S_MAX);
  }

  function stabiliteApresEchec(difficulte, stabilite, retrouvabilite_) {
    // Après un échec la stabilité chute, mais elle ne repart PAS de zéro :
    // c'est la différence de fond avec le système de boîtes (Leitner).
    const apresOubli = borner(
      W[11] *
      Math.pow(difficulte, -W[12]) *
      (Math.pow(stabilite + 1, W[13]) - 1) *
      Math.exp((1 - retrouvabilite_) * W[14]),
      S_MIN, S_MAX);
    const plafond = stabilite / Math.exp(W[17] * W[18]);
    return Math.max(S_MIN, Math.min(apresOubli, plafond));
  }

  /* Calcule le nouvel état (stabilité + difficulté) d'une carte.
     etat = null pour une carte jamais révisée.
     note : 1 Raté, 2 Difficile, 3 Correct, 4 Facile. */
  function prochainEtat(etat, joursEcoules, note) {
    if (!etat) {
      return {
        stabilite: stabiliteInitiale(note),
        difficulte: difficulteInitiale(note)
      };
    }
    const r = retrouvabilite(joursEcoules, etat.stabilite);
    const stabilite = (note === 1)
      ? stabiliteApresEchec(etat.difficulte, etat.stabilite, r)
      : stabiliteApresReussite(etat.difficulte, etat.stabilite, r, note);
    return {
      stabilite: stabilite,
      difficulte: prochaineDifficulte(etat.difficulte, note)
    };
  }

  return {
    W: W,
    DECAY: DECAY,
    FACTEUR: FACTEUR,
    retrouvabilite: retrouvabilite,
    intervalle: intervalle,
    prochainEtat: prochainEtat,
    stabiliteInitiale: stabiliteInitiale,
    difficulteInitiale: difficulteInitiale
  };
})();
