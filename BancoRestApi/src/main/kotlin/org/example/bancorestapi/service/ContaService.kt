package org.example.bancorestapi.service

import org.springframework.transaction.annotation.Transactional
import org.example.bancorestapi.domain.ChavePix
import org.example.bancorestapi.dto.PixTransferRequestDTO
import org.example.bancorestapi.dto.PixTransferResponseDTO
import org.example.bancorestapi.domain.Conta
import org.example.bancorestapi.domain.TipoTransacao
import org.example.bancorestapi.domain.Transacao
import org.example.bancorestapi.domain.toResponseDTO
import org.example.bancorestapi.dto.ChavePixResponseDTO
import org.example.bancorestapi.repository.ChavePixRepository
import org.example.bancorestapi.repository.ContaRepository
import org.example.bancorestapi.repository.TransacaoRepository
import org.springframework.stereotype.Service
import org.springframework.beans.factory.annotation.Autowired
import java.math.BigDecimal
import java.time.LocalDateTime
import java.time.ZoneId

@Service
class ContaService (
    private val transacaoRepository: TransacaoRepository,
    private val chavePixRepository: ChavePixRepository,
    private val contaRepository: ContaRepository
) {
    @Autowired
    private lateinit var notificationService: NotificationService

    @Transactional
    fun realizarTransferenciaPix(request: PixTransferRequestDTO): PixTransferResponseDTO {

        if (request.valor <= BigDecimal.ZERO) {
            throw RuntimeException("O valor da transferência deve ser positivo.")
        }

        val contaOrigem: Conta = contaRepository.findByNumeroConta(request.numeroContaOrigem.trim())
            ?: throw RuntimeException("Conta de origem não encontrada")

        val chavePix: ChavePix = chavePixRepository.findByChave(request.chaveDestino.trim())
            ?: throw RuntimeException("Chave pix não encontrada")

        val contaDestinoDaChave: Conta = chavePix.conta

        val idDestino = contaDestinoDaChave.id
            ?: throw RuntimeException("A chave PIX não tem ID de conta associado")

        val contaDestino: Conta = contaRepository.findById(idDestino)
            ?: throw RuntimeException("A conta de destino (ID: $idDestino) não foi encontrada.")

        if (contaOrigem.saldo < request.valor) {
            throw RuntimeException("Saldo indisponivel")
        }

        if (contaOrigem.numeroConta == contaDestino.numeroConta) {
            throw RuntimeException("Não pode realizer uma transferencia para a mesma conta")
        }

        contaOrigem.saldo = contaOrigem.saldo.subtract(request.valor)
        contaDestino.saldo = contaDestino.saldo.add(request.valor)

        contaRepository.saveAll(listOf(contaOrigem, contaDestino))

        val agoraBrasilia: LocalDateTime = LocalDateTime.now(ZoneId.of("America/Sao_Paulo"))

        val debito = Transacao()
        debito.conta = contaOrigem
        debito.dataHora = agoraBrasilia
        debito.tipo = TipoTransacao.PIX
        debito.valor = request.valor.negate()

        val credito = Transacao()
        credito.conta = contaDestino
        credito.dataHora = agoraBrasilia
        credito.tipo = TipoTransacao.PIX
        credito.valor = request.valor

        transacaoRepository.saveAll(listOf(debito, credito))

        notificationService.publishTransferenceNotification(
            contaDestino.numeroConta,
            request.valor,
            "PIX"
        )

        val response = PixTransferResponseDTO(
            status = "Sucesso",
            mensagem = "Transferencia PIX realizada com sucesso",
            novoSaldoOrigem = contaOrigem.saldo,
            numeroContaDestino = contaDestino.numeroConta
        )

        return response
    }

    @Transactional
    fun getChavePix(numeroConta: String) : List<ChavePixResponseDTO> {
        val conta: Conta = contaRepository.findByNumeroConta(numeroConta)
            ?: throw RuntimeException("Esse numero não corresponde a nenhuma conta")

        val chavesPixEncontradas: List<ChavePix> = chavePixRepository.findByConta(conta)

        return chavesPixEncontradas.map { chavePix ->
            chavePix.toResponseDTO()
        }

    }
}